use std::path::Path;
use std::sync::LazyLock;
use std::time::Instant;

use eyeball::SharedObservable;
use matrix_sdk::attachment::{AttachmentConfig, AttachmentInfo, BaseFileInfo, BaseImageInfo};
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::events::{AnyMessageLikeEventContent, Mentions};
use matrix_sdk::ruma::html::{HtmlSanitizerMode, RemoveReplyFallback};
use matrix_sdk::ruma::{OwnedUserId, RoomId, UserId};
use matrix_sdk::send_queue::{LocalEchoContent, RoomSendQueueUpdate};
use matrix_sdk::TransmissionProgress;
use matrix_sdk::{Client, Room};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::broadcast::error::RecvError;
use ts_rs::TS;

/// Recorder metadata shared by native IPC and web multipart attachments.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "../src/bindings/")]
pub struct VoiceMessageMetadata {
    pub duration_ms: u32,
    pub waveform: Vec<f32>,
}

/// In-memory microphone recording; never interpreted as a filesystem path.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordedAudioUpload {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

pub const MAX_VOICE_RECORDING_UPLOAD_BYTES: u64 = 32 * 1024 * 1024;

/// Validate recorder metadata before the existing encrypted upload. Errors
/// deliberately omit microphone samples and other caller-provided values.
pub fn voice_attachment_info(
    mime: &mime::Mime,
    size_bytes: u64,
    metadata: &VoiceMessageMetadata,
) -> Result<AttachmentInfo, String> {
    if mime.type_() != mime::AUDIO {
        return Err("voice recording must use an audio media type".to_string());
    }
    if size_bytes == 0 || size_bytes > MAX_VOICE_RECORDING_UPLOAD_BYTES {
        return Err("voice recording size is outside the supported range".to_string());
    }
    if metadata.duration_ms == 0 || metadata.duration_ms > 600_000 {
        return Err(
            "voice recording duration must be positive and at most ten minutes".to_string(),
        );
    }
    if metadata.waveform.is_empty()
        || metadata.waveform.len() > 120
        || metadata
            .waveform
            .iter()
            .any(|sample| !sample.is_finite() || !(0.0..=1.0).contains(sample))
    {
        return Err("voice recording waveform is invalid".to_string());
    }
    Ok(AttachmentInfo::Voice(
        matrix_sdk::attachment::BaseAudioInfo {
            duration: Some(std::time::Duration::from_millis(
                metadata.duration_ms.into(),
            )),
            size: Some(
                size_bytes
                    .try_into()
                    .map_err(|_| "voice recording is too large".to_string())?,
            ),
            waveform: Some(metadata.waveform.clone()),
        },
    ))
}

/// Rotation/flip implied by an EXIF `Orientation` tag (values 2-8; 1 is
/// already upright and needs no transform). `image`'s decoders don't apply
/// this automatically, so stripping EXIF (which silently discards the tag)
/// would otherwise leave portrait photos sideways — this is read from the
/// original bytes before the strip and baked into the pixels instead.
fn apply_exif_orientation(img: image::DynamicImage, orientation: u32) -> image::DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

/// Detects an animated PNG (APNG) by scanning the raw chunk stream for an
/// `acTL` chunk ahead of the first `IDAT` — the same ordering rule
/// (https://wiki.mozilla.org/APNG_Specification#.60acTL.60:_The_Animation_Control_Chunk)
/// browsers and the PNG spec itself use to distinguish "a static PNG with an
/// unrelated `acTL`-shaped byte sequence somewhere after image data" from a
/// genuine APNG. `image::guess_format`/`ImageFormat::Png` can't tell an APNG
/// apart from a static one — both are valid PNG containers — so this must be
/// checked separately before treating a PNG as safe to decode-and-re-encode.
fn is_animated_png(data: &[u8]) -> bool {
    const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
    if data.len() < PNG_SIGNATURE.len() || data[..PNG_SIGNATURE.len()] != PNG_SIGNATURE {
        return false;
    }

    let mut pos = PNG_SIGNATURE.len();
    while pos + 8 <= data.len() {
        let length =
            u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;
        let chunk_type = &data[pos + 4..pos + 8];
        match chunk_type {
            b"acTL" => return true,
            // Per the APNG spec, `acTL` (if present) must precede the first
            // `IDAT` — reaching `IDAT` first means this is a static PNG, or
            // at best a malformed APNG that browsers themselves would also
            // render as static.
            b"IDAT" => return false,
            _ => {}
        }
        // 4-byte length + 4-byte type + `length` bytes of data + 4-byte CRC.
        let Some(next) = pos
            .checked_add(8)
            .and_then(|p| p.checked_add(length)?.checked_add(4))
        else {
            return false;
        };
        pos = next;
    }
    false
}

/// Strips EXIF/metadata (GPS location, camera info, capture timestamp, etc.)
/// from a JPEG or PNG image by decoding and re-encoding it — `image`'s
/// encoders don't carry the source's metadata segments forward, so a
/// straightforward round-trip is a real strip, not just a best-effort one.
/// Bakes in any EXIF `Orientation` first so the re-encoded, metadata-free
/// image still displays upright. Returns `None` (leaving the original bytes
/// untouched) for animated GIF/WebP/PNG — re-encoding through
/// `image::DynamicImage` would collapse them to a single frame, which is
/// worse than leaving their (comparatively low-signal) metadata in place —
/// and for anything that fails to decode, so a corrupt-but-otherwise-
/// uploadable file still sends.
///
/// `pub` (not module-private) so `charm-web-server`'s `send_attachment` route
/// can apply the same EXIF stripping the desktop command does — see that
/// route's doc comment.
pub fn strip_exif(mime: &mime::Mime, data: &[u8]) -> Option<Vec<u8>> {
    // Sniff the actual bytes first, not just the caller-supplied MIME — both
    // desktop (from a file extension) and web (from a `File`'s reported
    // type) can hand this a wrong or missing type for a real JPEG/PNG (e.g.
    // a camera file renamed without an extension, or a browser `File` with a
    // generic `application/octet-stream`), which would otherwise silently
    // skip stripping and upload the original GPS/capture EXIF intact. Fall
    // back to the MIME-derived format only when sniffing can't tell.
    let format = image::guess_format(data)
        .ok()
        .filter(|format| matches!(format, image::ImageFormat::Jpeg | image::ImageFormat::Png))
        .or_else(|| match (mime.type_().as_str(), mime.subtype().as_str()) {
            ("image", "jpeg") => Some(image::ImageFormat::Jpeg),
            ("image", "png") => Some(image::ImageFormat::Png),
            _ => None,
        })?;

    // Review fix: an APNG is still a well-formed PNG container, so the
    // format sniff/MIME check above accepts it — but the decode-and-
    // re-encode round trip below goes through a single `DynamicImage`,
    // silently collapsing an animated sticker/screenshot to its first
    // frame. Bail out the same way animated GIF/WebP already do.
    if format == image::ImageFormat::Png && is_animated_png(data) {
        return None;
    }

    let orientation = exif::Reader::new()
        .read_from_container(&mut std::io::Cursor::new(data))
        .ok()
        .and_then(|exif| {
            exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
                .cloned()
        })
        .and_then(|field| field.value.get_uint(0))
        .unwrap_or(1);

    let img = image::load_from_memory_with_format(data, format).ok()?;
    let img = apply_exif_orientation(img, orientation);

    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), format)
        .ok()?;
    Some(out)
}

use super::MatrixState;

const IPC_OPERATION_ID_HEADER: &str = "x-charm-operation-id";

/// Client-side sanity cap on outbound attachments. Not a substitute for
/// homeserver upload-size policy (which still applies independently and can
/// reject a smaller file too) — just a bound so an unexpectedly huge
/// `file_path` isn't read fully into memory before any upload even starts.
pub const MAX_ATTACHMENT_UPLOAD_BYTES: u64 = 100 * 1024 * 1024;

fn ipc_operation_id(request: &tauri::ipc::Request<'_>) -> Option<String> {
    request
        .headers()
        .get(IPC_OPERATION_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| is_valid_ipc_operation_id(value))
        .map(ToOwned::to_owned)
}

fn is_valid_ipc_operation_id(value: &str) -> bool {
    let Some(suffix) = value.strip_prefix("ipc-") else {
        return false;
    };

    !suffix.is_empty()
        && suffix.len() <= 96
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn add_attachment_ipc_breadcrumb(
    level: sentry::Level,
    status: &str,
    operation_id: Option<&str>,
    total_bytes: Option<u64>,
    mime: Option<&mime::Mime>,
    duration_ms: Option<u128>,
) {
    let mut data = sentry::protocol::Map::new();
    data.insert("command".into(), serde_json::json!("send_attachment"));
    data.insert("status".into(), serde_json::json!(status));
    if let Some(total_bytes) = total_bytes {
        data.insert("totalBytes".into(), serde_json::json!(total_bytes));
    }
    if let Some(mime) = mime {
        data.insert("mimeClass".into(), serde_json::json!(mime.type_().as_str()));
    }
    if let Some(operation_id) = operation_id {
        data.insert("operationId".into(), serde_json::json!(operation_id));
    }
    if let Some(duration_ms) = duration_ms {
        data.insert("durationMs".into(), serde_json::json!(duration_ms));
    }

    sentry::add_breadcrumb(sentry::Breadcrumb {
        ty: "default".into(),
        category: Some("tauri.ipc.attachment".into()),
        level,
        message: Some(format!("Attachment IPC {status}")),
        data,
        ..Default::default()
    });
}

/// Pushed to the frontend as an attachment upload progresses. `sent`/`total`
/// are in bytes. The vendored matrix-rust-sdk (0.18.0) exposes real
/// byte-level upload progress via `SendAttachment::with_send_progress_observable`
/// (an `eyeball::SharedObservable<TransmissionProgress>`), so this carries
/// genuine incremental progress rather than a start/complete-only fabrication
/// — see `send_attachment` below for how it's wired up.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct UploadProgress {
    pub txn_id: String,
    pub room_id: String,
    #[ts(type = "number")]
    pub sent: u64,
    #[ts(type = "number")]
    pub total: u64,
}

/// Serializes the whole subscribe -> send -> observe-echo sequence in
/// [`send_and_capture_transaction_id`] across every room and every caller.
/// Without this, two overlapping calls (e.g. a message and a reply sent in
/// quick succession, even to different rooms) could both end up reading the
/// *first* `NewLocalEvent` off the shared broadcast stream and return the
/// same transaction id — reconciling the second optimistic echo against the
/// wrong event and leaving it without its own `send_queue:update`. A single
/// global lock (rather than per-room) is a deliberately blunt fix: this path
/// isn't hot enough (interactive, human-paced sends) for cross-room
/// serialization to matter, and it avoids maintaining a per-room lock map.
pub(super) static SEND_CAPTURE_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Queues `content` on `room`'s send queue and returns the SDK-generated
/// transaction id for the resulting local echo.
///
/// matrix-rust-sdk 0.18's `SendHandle` (the `Ok` value of
/// `RoomSendQueue::send`) doesn't expose a public transaction-id getter —
/// unlike `SendReactionHandle`/`SendRedactionHandle`, which do — so the only
/// way to observe the id a given `send()` call was assigned is to subscribe
/// to the client-wide send-queue update stream *before* calling `send()` and
/// read off the `NewLocalEvent` broadcast that `send()` itself triggers
/// (synchronously, before it returns) for this room. This id is what lets a
/// synced event (`unsigned.transaction_id`, see `timeline::events_to_summaries`)
/// and the send-queue's own `pending`/`sent`/`error` updates
/// (`send_queue:update`) both key back to the same local echo the frontend
/// created — without it, none of the three ever agree, so the echo never
/// reconciles with the real event and never leaves "pending".
pub async fn send_and_capture_transaction_id(
    client: &Client,
    room: &Room,
    content: AnyMessageLikeEventContent,
) -> Result<String, String> {
    let _guard = SEND_CAPTURE_LOCK.lock().await;

    if super::actions::room_upgrade_queue_is_paused(room.room_id()).await {
        return Err("Room sending is paused while its current state is verified.".to_string());
    }

    let mut updates = client.send_queue().subscribe();
    let target_room_id = room.room_id().to_owned();

    room.send_queue()
        .send(content)
        .await
        .map_err(|e| e.to_string())?;

    // Bounded, not an unconditional `loop`: this runs under `SEND_CAPTURE_LOCK`,
    // so if the specific `NewLocalEvent` we're waiting for was itself one of
    // the updates a `Lagged` skipped over (possible, if unlikely — we only
    // just subscribed), waiting forever would hold that lock and deadlock
    // every subsequent send/reply/edit/reaction for the rest of the session.
    // 5s is generous for what's normally a same-process, no-network signal.
    let wait_for_echo = async {
        loop {
            match updates.recv().await {
                Ok(update) if update.room_id == target_room_id => {
                    if let RoomSendQueueUpdate::NewLocalEvent(echo) = update.update {
                        return Ok(echo.transaction_id.to_string());
                    }
                }
                Ok(_) => continue,
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => {
                    return Err(
                        "send queue closed before the local echo could be observed".to_string()
                    )
                }
            }
        }
    };

    match tokio::time::timeout(std::time::Duration::from_secs(5), wait_for_echo).await {
        Ok(result) => result,
        Err(_) => Err(
            "timed out waiting for the local echo — the send was queued, but its transaction id \
             couldn't be observed"
                .to_string(),
        ),
    }
}

/// Queues a message for sending via matrix-rust-sdk's send queue. When
/// `formatted_body` is present the event is sent as `msgtype: m.text` with
/// `format: org.matrix.custom.html` (`RoomMessageEventContent::text_html`);
/// otherwise it's plain `text_plain`. The frontend (see `Composer.tsx`'s
/// serializer) is responsible for deciding when formatting is real enough to
/// warrant a `formatted_body` at all, and for sanitizing the HTML against the
/// Matrix-permitted tag/attr allowlist before it ever reaches this command —
/// this command trusts `formatted_body` as already-sanitized.
/// `mentions` (bare Matrix user ids, e.g. `@alice:example.org`) populate
/// `m.mentions.user_ids` via `add_mentions`.
///
/// This returns as soon as the event is queued, not once the homeserver has
/// accepted it — the send queue handles the network round-trip, retries, and
/// offline queueing on its own. Returns the SDK's transaction id (see
/// [`send_and_capture_transaction_id`]) so the frontend can key its optimistic
/// echo the same way the synced event and `send_queue:update` will.
#[tauri::command]
pub async fn send_message(
    state: State<'_, MatrixState>,
    room_id: String,
    body: String,
    formatted_body: Option<String>,
    mentions: Option<Vec<String>>,
) -> Result<String, String> {
    let client = state.require_client().await?;

    let parsed_room_id = RoomId::parse(&room_id).map_err(|e| e.to_string())?;
    let room = client
        .get_room(&parsed_room_id)
        .ok_or_else(|| format!("room {room_id} not found"))?;

    let content = build_message_content(body, formatted_body, mentions)?;
    let content = AnyMessageLikeEventContent::RoomMessage(content);
    send_and_capture_transaction_id(&client, &room, content).await
}

/// Forwards an existing event (`event_id`, in `source_room_id`) into
/// `target_room_id` as a brand-new message: fetches the source event's
/// `RoomMessageEventContent`, strips any `m.relates_to` (a forwarded message
/// shouldn't carry the original's reply/edit relation), and queues it via
/// the normal send-queue path in the target room. Returns the new
/// transaction id, same convention as [`super::actions::send_reply`].
#[tauri::command]
pub async fn forward_message(
    state: State<'_, MatrixState>,
    source_room_id: String,
    event_id: String,
    target_room_id: String,
) -> Result<String, String> {
    let client = state.require_client().await?;
    forward_message_impl(&client, &source_room_id, &event_id, &target_room_id).await
}

/// Same page-limit rationale as `room_admin::latest_edit_body`: a single
/// relations page only covers the 20 most recent relations, so if enough
/// newer ones (extra reactions, other members' invalid same-target
/// replacements) sit in front of the real latest same-sender edit, it could
/// be missed entirely. Pages forward until a same-sender replacement is
/// found or the relation stream is exhausted, bounded by
/// `MAX_EDIT_RELATION_PAGES` as a safety cap. Unlike `latest_edit_body`
/// (which only needs the edited body string for a preview), this returns
/// the full replacement content so the caller can `apply_replacement` it.
///
/// Review fix: returns `Result` rather than swallowing a lookup failure into
/// `None` — the caller must be able to tell "the network request failed" (a
/// real error the forward should abort on) apart from "walked every page and
/// found no same-sender replacement" (a genuine, safe-to-treat-as-no-edit
/// `Ok(None)`). Collapsing both to `None` previously meant a transient
/// `/relations` failure looked identical to "there is no edit", so the
/// forward would silently fall back to `original_message.content` and
/// re-share content the sender had actually edited away.
struct ServerReplacement {
    transaction_id: Option<String>,
    origin_server_ts: u64,
    new_content: matrix_sdk::ruma::events::room::message::RoomMessageEventContentWithoutRelation,
}

async fn latest_replacement_content(
    room: &Room,
    event_id: &matrix_sdk::ruma::EventId,
    original_sender: &matrix_sdk::ruma::UserId,
) -> Result<Option<ServerReplacement>, String> {
    use matrix_sdk::room::{IncludeRelations, RelationsOptions};
    use matrix_sdk::ruma::events::relation::RelationType;
    use matrix_sdk::ruma::events::room::message::Relation;
    use matrix_sdk::ruma::events::{
        AnySyncMessageLikeEvent, AnySyncTimelineEvent, SyncMessageLikeEvent,
    };

    const MAX_EDIT_RELATION_PAGES: usize = 10;
    let mut from: Option<String> = None;

    for _ in 0..MAX_EDIT_RELATION_PAGES {
        let relations = room
            .relations(
                event_id.to_owned(),
                RelationsOptions {
                    dir: matrix_sdk::ruma::api::Direction::Backward,
                    include_relations: IncludeRelations::RelationsOfType(RelationType::Replacement),
                    limit: matrix_sdk::ruma::UInt::new(20),
                    from: from.clone(),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| e.to_string())?;

        // Same defensive re-sort as `latest_edit_body`: nothing guarantees
        // the homeserver actually honored `dir: Backward`, so sort by
        // `origin_server_ts` explicitly rather than trusting response order.
        let mut candidates: Vec<_> = relations
            .chunk
            .iter()
            .filter_map(|candidate| {
                let raw_edit = candidate.raw().deserialize().ok()?;
                let edit = match raw_edit {
                    AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(
                        SyncMessageLikeEvent::Original(edit),
                    )) => edit,
                    _ => return None,
                };
                if edit.sender != *original_sender {
                    return None;
                }
                let Relation::Replacement(replacement) = edit.content.relates_to.clone()? else {
                    return None;
                };
                // Same defensive re-check as `latest_edit_body`: the
                // request is scoped to `event_id`, but nothing guarantees a
                // homeserver/aggregation response actually honors that
                // scoping.
                if replacement.event_id != *event_id {
                    return None;
                }
                Some(ServerReplacement {
                    transaction_id: edit
                        .unsigned
                        .transaction_id
                        .as_ref()
                        .map(ToString::to_string),
                    origin_server_ts: edit.origin_server_ts.0.into(),
                    new_content: replacement.new_content,
                })
            })
            .collect();
        candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.origin_server_ts));
        if let Some(candidate) = candidates.into_iter().next() {
            return Ok(Some(candidate));
        }

        match relations.next_batch_token {
            Some(next) => from = Some(next),
            // The relation stream is genuinely exhausted (no more pages to
            // walk) without finding a same-sender replacement — `None` here
            // is a real answer, not a truncated one.
            None => return Ok(None),
        }
    }

    // Review fix: hit `MAX_EDIT_RELATION_PAGES` while `next_batch_token` was
    // still `Some` on the last page — there could be more relations beyond
    // the cap, so "no edit found within the pages we looked at" is not the
    // same as "there is no edit". Treating this the same as a genuine
    // `Ok(None)` let `forward_message_impl` silently forward
    // `original_message.content`, potentially re-sharing text the sender
    // had actually edited away just past the cap.
    Err(format!(
        "edit relation lookup for {event_id} exceeded the {MAX_EDIT_RELATION_PAGES}-page \
         limit without exhausting the relation stream"
    ))
}

/// A queued local replacement that has not reached the homeserver yet.
///
/// Kept module-visible so edit history and forwarding use the same send-queue
/// view instead of disagreeing while an edit is pending.
pub(super) struct PendingReplacement {
    pub transaction_id: String,
    pub origin_server_ts: u64,
    pub new_content:
        matrix_sdk::ruma::events::room::message::RoomMessageEventContentWithoutRelation,
}

/// Returns queued local replacements for `event_id`, in send-queue order.
/// `/relations` cannot see these local echoes, but the timeline already
/// applies them optimistically.
pub(super) async fn pending_replacements(
    room: &Room,
    event_id: &matrix_sdk::ruma::EventId,
) -> Result<Vec<PendingReplacement>, String> {
    use matrix_sdk::ruma::events::room::message::Relation;

    let (local_echoes, _updates) = room
        .send_queue()
        .subscribe()
        .await
        .map_err(|e| e.to_string())?;

    Ok(local_echoes
        .into_iter()
        .filter_map(|echo| {
            let transaction_id = echo.transaction_id.to_string();
            let LocalEchoContent::Event {
                serialized_event,
                send_handle,
                ..
            } = echo.content
            else {
                return None;
            };
            let Ok(AnyMessageLikeEventContent::RoomMessage(content)) =
                serialized_event.deserialize()
            else {
                return None;
            };
            let Some(Relation::Replacement(replacement)) = content.relates_to else {
                return None;
            };
            (replacement.event_id == *event_id).then(|| PendingReplacement {
                transaction_id,
                origin_server_ts: send_handle.created_at.0.into(),
                new_content: replacement.new_content,
            })
        })
        .collect())
}

fn latest_effective_replacement(
    server_edit: Option<ServerReplacement>,
    pending_edits: Vec<PendingReplacement>,
) -> Option<matrix_sdk::ruma::events::room::message::RoomMessageEventContentWithoutRelation> {
    let acknowledged_transaction_id = server_edit
        .as_ref()
        .and_then(|replacement| replacement.transaction_id.as_deref());
    let pending_edit = pending_edits
        .into_iter()
        .filter(|replacement| {
            Some(replacement.transaction_id.as_str()) != acknowledged_transaction_id
        })
        .max_by_key(|replacement| replacement.origin_server_ts);

    match (server_edit, pending_edit) {
        (Some(server), Some(pending)) if pending.origin_server_ts > server.origin_server_ts => {
            Some(pending.new_content)
        }
        (Some(server), _) => Some(server.new_content),
        (None, Some(pending)) => Some(pending.new_content),
        (None, None) => None,
    }
}

/// Core logic behind [`forward_message`].
pub async fn forward_message_impl(
    client: &Client,
    source_room_id: &str,
    event_id: &str,
    target_room_id: &str,
) -> Result<String, String> {
    let parsed_source_room_id = RoomId::parse(source_room_id).map_err(|e| e.to_string())?;
    let source_room = client
        .get_room(&parsed_source_room_id)
        .ok_or_else(|| format!("room {source_room_id} not found"))?;

    let parsed_event_id = matrix_sdk::ruma::EventId::parse(event_id).map_err(|e| e.to_string())?;
    let source_event = source_room
        .load_or_fetch_event(&parsed_event_id, None)
        .await
        .map_err(|e| e.to_string())?;

    let deserialized: matrix_sdk::ruma::events::AnySyncTimelineEvent = source_event
        .kind
        .raw()
        .deserialize()
        .map_err(|e| e.to_string())?;
    let matrix_sdk::ruma::events::AnySyncTimelineEvent::MessageLike(
        matrix_sdk::ruma::events::AnySyncMessageLikeEvent::RoomMessage(msg),
    ) = deserialized
    else {
        return Err("source event is not a room message".to_string());
    };
    let original_message = msg
        .as_original()
        .ok_or_else(|| "source event has already been redacted".to_string())?;

    // Forward whatever is currently shown in the timeline, not the pre-edit
    // original: find the latest same-sender `m.replace` targeting this event
    // and apply it if one exists. Paginated the same way
    // `room_admin::latest_edit_body` is (see that function's own doc
    // comment for why a single relations page isn't enough) — a
    // single-page `load_or_fetch_event_with_relations` call could miss the
    // real latest edit behind enough newer relations (reactions, or other
    // members' invalid same-target replacements), silently forwarding
    // pre-edit content the sender specifically edited away.
    // Propagate a lookup failure as an error (abort the forward) rather than
    // falling back to `original_message.content` — see
    // `latest_replacement_content`'s doc comment for why treating "the
    // request failed" the same as "there is no edit" is unsafe here.
    // Snapshot the queue first. If an edit is acknowledged while the
    // relations request is in flight, it remains represented by this local
    // snapshot; taking the server snapshot first could miss it in both
    // places when the queue removes the echo between the two reads.
    let pending_edits = pending_replacements(&source_room, &parsed_event_id).await?;
    let server_edit =
        latest_replacement_content(&source_room, &parsed_event_id, &original_message.sender)
            .await?;
    let latest_edit = latest_effective_replacement(server_edit, pending_edits);

    let mut content = original_message.content.clone();
    if let Some(new_content) = latest_edit {
        content.apply_replacement(new_content);
    }
    // A reply's body/formatted_body carries the quoted rich-reply fallback
    // ("> <@user:server> ..."), which `sanitize` only strips while
    // `relates_to` still says this is a reply — so this must run before
    // clearing it below, same ordering `rooms::room_message_preview_from_raw`
    // uses for the last-message preview.
    content.sanitize(HtmlSanitizerMode::Compat, RemoveReplyFallback::Yes);
    // Strip any relation (reply/edit) on the forwarded copy — forwarding
    // should send a clean new message, not a relation to the original.
    content.relates_to = None;
    // Also strip inherited `m.mentions` — a forwarded reply/mention-carrying
    // message would otherwise silently notify whoever the *original*
    // sender mentioned, in a room where the forwarder never mentioned them.
    content.mentions = None;

    let parsed_target_room_id = RoomId::parse(target_room_id).map_err(|e| e.to_string())?;
    let target_room = client
        .get_room(&parsed_target_room_id)
        .ok_or_else(|| format!("room {target_room_id} not found"))?;

    send_and_capture_transaction_id(
        client,
        &target_room,
        AnyMessageLikeEventContent::RoomMessage(content),
    )
    .await
}

/// Builds a `RoomMessageEventContent` from a plain body, an optional
/// sanitized HTML body, and optional mention user ids. Used by
/// `send_message`. `commands::run_command`'s `/me` arm does NOT go through
/// this — slash commands are typed as plain text in the composer (no
/// formatted body to carry), so it calls `RoomMessageEventContent::emote_plain`
/// directly instead.
pub fn build_message_content(
    body: String,
    formatted_body: Option<String>,
    mentions: Option<Vec<String>>,
) -> Result<RoomMessageEventContent, String> {
    let mut content = match formatted_body {
        Some(html) => RoomMessageEventContent::text_html(body, html),
        None => RoomMessageEventContent::text_plain(body),
    };

    if let Some(mention_ids) = mentions {
        if !mention_ids.is_empty() {
            let user_ids: Vec<OwnedUserId> = mention_ids
                .into_iter()
                .map(|id| UserId::parse(&id).map_err(|e| e.to_string()))
                .collect::<Result<_, _>>()?;
            content = content.add_mentions(Mentions::with_user_ids(user_ids));
        }
    }

    Ok(content)
}

/// Sends a file at `file_path` as an `m.image`/`m.video`/`m.audio`/`m.file`
/// attachment (msgtype chosen from the sniffed MIME type), with an optional
/// caption. Auto-encrypts in E2EE rooms (matrix-rust-sdk handles this
/// transparently inside `send_attachment`, same as `send_queue` does for
/// plain-text messages). Derives real dimensions for images via the `image`
/// crate (no client-side thumbnail image is generated/uploaded); video/audio
/// attachments get size-only info. All kinds rely on the homeserver's
/// `MediaFormat::Thumbnail` endpoint for thumbnails rather than a
/// client-generated one — the spec explicitly allows this for Day-1.
///
/// Deviation from the spec sketch: this calls `room.send_attachment()`
/// directly rather than routing through `room.send_queue()`, because
/// `RoomSendQueue` in the vendored SDK (0.18.0) does not expose a public
/// "queue a raw attachment with a caller-supplied progress observable" entry
/// point — its own internal media-upload progress plumbing
/// (`report_media_upload_progress` / `RoomSendQueueUpdate`) is queue-internal
/// and not something this command can hook into for a custom Tauri event
/// without forking significant queue internals. `send_attachment` itself
/// still uploads via `Client::media()` (auto-encrypting for E2EE rooms) and
/// posts through the normal room-send path, so offline queuing / retry from
/// the send queue is the one behavior not preserved for attachments — a
/// known, called-out gap rather than a silent one.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // one Tauri IPC command; splitting args into a struct would only move the count, not reduce it
pub async fn send_attachment(
    app: AppHandle,
    state: State<'_, MatrixState>,
    request: tauri::ipc::Request<'_>,
    room_id: String,
    file_path: String,
    caption: Option<String>,
    txn_id: String,
    strip_exif_enabled: bool,
    voice: Option<VoiceMessageMetadata>,
    recording: Option<RecordedAudioUpload>,
) -> Result<(), String> {
    let parsed_room_id = RoomId::parse(&room_id).map_err(|e| e.to_string())?;
    let operation_id = ipc_operation_id(&request);
    // Continues a trace started in the webview (see `observability_trace`'s
    // doc comment) — `None` when the frontend build predates this header or
    // had no active span at call time, matching `operation_id`'s own
    // "absent means off" shape just above.
    //
    // Deliberately never published onto the ambient/current Sentry scope
    // (`sentry::configure_scope`): that scope is shared process-wide, so two
    // overlapping `send_attachment` invocations racing to set/clear the
    // "current span" would corrupt each other regardless of completion
    // order — whichever clears it last (via `set_span(None)`) wins, even
    // over a still-in-flight sibling call, and whichever finishes can
    // detach the other's span entirely. `Transaction::finish()` submits
    // through the client captured at `start_transaction` time, not through
    // whatever hub is "current" later, so this transaction is fully
    // self-contained without needing to be current — the tradeoff is that
    // breadcrumbs/tracing events captured elsewhere during this call won't
    // automatically nest under it in Sentry's UI.
    let trace_transaction = crate::observability_trace::continue_ipc_trace(
        request.headers(),
        "send_attachment",
        "tauri.ipc",
    )
    .map(sentry::start_transaction);
    let started_at = Instant::now();
    let mut breadcrumb_total_bytes = None;
    let mut breadcrumb_mime = None;
    add_attachment_ipc_breadcrumb(
        sentry::Level::Info,
        "started",
        operation_id.as_deref(),
        None,
        None,
        None,
    );
    tracing::info!(
        command = "send_attachment",
        status = "started",
        has_operation_id = operation_id.is_some(),
        "Attachment IPC started"
    );

    // Registered before any `.await` so a cancel request that arrives while
    // this command is still reading the file off disk isn't lost — it just
    // flips the token, and the `tokio::select!` below observes it as soon as
    // the upload future actually starts. Removed unconditionally once this
    // call settles (success, failure, or cancellation) so the map doesn't
    // grow across a session's uploads.
    let txn_id_for_cancellation = txn_id.clone();
    let cancellation = tokio_util::sync::CancellationToken::new();
    state
        .attachment_cancellations
        .lock()
        .expect("attachment_cancellations mutex poisoned")
        .insert(
            txn_id_for_cancellation.clone(),
            (parsed_room_id.clone(), cancellation.clone()),
        );

    let result = async {
        // Serialize barrier publication with upload admission. Registering the
        // room-scoped cancellation token before this await means whichever
        // side wins the lock either rejects this upload or can cancel it.
        let _send_guard = SEND_CAPTURE_LOCK.lock().await;
        if super::actions::room_upgrade_queue_is_paused(&parsed_room_id).await {
            return Err("This room is read-only while its current state is verified.".to_string());
        }
        let client = state.require_client().await?;

        let room = client
            .get_room(&parsed_room_id)
            .ok_or_else(|| format!("room {room_id} not found"))?;
        drop(_send_guard);

        let (filename, mime, data) = if let Some(recording) = recording {
            if !file_path.is_empty() {
                return Err(
                    "recording and filesystem attachment are mutually exclusive".to_string()
                );
            }
            let metadata = voice
                .as_ref()
                .ok_or_else(|| "recording metadata is required".to_string())?;
            let mime: mime::Mime = recording
                .mime_type
                .parse()
                .map_err(|_| "invalid recording media type".to_string())?;
            voice_attachment_info(&mime, recording.bytes.len() as u64, metadata)?;
            let extension = match mime.subtype().as_str() {
                "ogg" => "ogg",
                "webm" => "webm",
                "mp4" => "m4a",
                "wav" | "wave" | "x-wav" => "wav",
                _ => return Err("unsupported recording audio format".to_string()),
            };
            (format!("Voice message.{extension}"), mime, recording.bytes)
        } else {
            let path = Path::new(&file_path);
            let filename = path
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| "file_path has no filename component".to_string())?
                .to_string();

            let metadata = tokio::fs::metadata(&path)
                .await
                .map_err(|e| e.to_string())?;
            // `is_file()` follows symlinks and reflects the *target's* file type, so
            // this also rejects a symlink pointed at a device/pipe/proc special file
            // masquerading as an attachment, not just directories.
            if !metadata.is_file() {
                return Err("file_path does not refer to a regular file".to_string());
            }
            if metadata.len() > MAX_ATTACHMENT_UPLOAD_BYTES {
                return Err(format!(
                    "attachment is {} bytes, over the {MAX_ATTACHMENT_UPLOAD_BYTES}-byte limit",
                    metadata.len()
                ));
            }

            let data = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            (filename, mime, data)
        };
        // Best-effort: an unstrippable image (animated GIF/WebP, or one that
        // fails to decode) sends with its original bytes rather than failing
        // the whole upload — see `strip_exif`'s doc comment for why.
        let data = if strip_exif_enabled {
            strip_exif(&mime, &data).unwrap_or(data)
        } else {
            data
        };
        let total_bytes = data.len() as u64;
        breadcrumb_total_bytes = Some(total_bytes);
        breadcrumb_mime = Some(mime.clone());
        tracing::info!(
            command = "send_attachment",
            status = "metadata_loaded",
            total_bytes,
            mime_class = mime.type_().as_str(),
            "Attachment IPC metadata loaded"
        );

        // Caller-supplied, not server-generated: the frontend creates its
        // optimistic upload row (keyed on a locally generated ID) before
        // invoking this command, so this command must reuse that same ID for
        // its `upload:progress` events rather than minting its own — otherwise
        // the two sides can never correlate and the progress bar never updates.
        let txn_id_string = txn_id.clone();
        let ruma_txn_id: matrix_sdk::ruma::OwnedTransactionId = txn_id.into();

        let info = match voice.as_ref() {
            Some(metadata) => voice_attachment_info(&mime, total_bytes, metadata)?,
            None => attachment_info_for(&mime, &data, total_bytes),
        };

        let mut config = AttachmentConfig::new().txn_id(ruma_txn_id).info(info);
        if let Some(caption) = caption {
            config = config.caption(Some(
                matrix_sdk::ruma::events::room::message::TextMessageEventContent::plain(caption),
            ));
        }

        let progress =
            SharedObservable::<TransmissionProgress>::new(TransmissionProgress::default());
        let forwarder = spawn_progress_forwarder(
            app.clone(),
            progress.clone(),
            txn_id_string.clone(),
            room_id.clone(),
            total_bytes,
        );

        let send = room
            .send_attachment(filename, &mime, data, config)
            .with_send_progress_observable(progress.clone());

        // Races the upload against a user-initiated cancel
        // (`cancel_attachment_upload` flips `cancellation`). Dropping `send`
        // (what `select!` does to the losing branch) drops the underlying
        // `Client::media()` upload request future, which tears down its
        // in-flight HTTP body stream rather than letting it run to
        // completion in the background.
        let result = tokio::select! {
            result = send => result.map_err(|error| error.to_string()),
            () = cancellation.cancelled() => Err("upload cancelled".to_string()),
        };
        // The forwarder task holds its own clone of `progress`'s subscriber, so
        // dropping the local `progress` binding here doesn't close its stream —
        // abort it explicitly (same pattern as `qr_login.rs`) rather than
        // leaking a task per upload.
        forwarder.abort();

        if result.is_ok() {
            // Emit a terminal progress event so the frontend's progress bar can
            // clear deterministically, whether or not the observable delivered a
            // final tick before completion (its update cadence isn't guaranteed
            // to land exactly on 100%). Only emitted on success — emitting this
            // on failure would read as 100%-complete to the frontend and mask
            // the error.
            let _ = app.emit(
                "upload:progress",
                UploadProgress {
                    txn_id: txn_id_string,
                    room_id: room_id.clone(),
                    sent: total_bytes,
                    total: total_bytes,
                },
            );
        }

        result.map(|_| ())
    }
    .await;

    state
        .attachment_cancellations
        .lock()
        .expect("attachment_cancellations mutex poisoned")
        .remove(&txn_id_for_cancellation);

    let duration_ms = started_at.elapsed().as_millis();
    let tracing_duration_ms = u64::try_from(duration_ms).unwrap_or(u64::MAX);
    let outcome = match result {
        Ok(_) => {
            add_attachment_ipc_breadcrumb(
                sentry::Level::Info,
                "succeeded",
                operation_id.as_deref(),
                breadcrumb_total_bytes,
                breadcrumb_mime.as_ref(),
                Some(duration_ms),
            );
            tracing::info!(
                command = "send_attachment",
                status = "succeeded",
                total_bytes = ?breadcrumb_total_bytes,
                mime_class = ?breadcrumb_mime.as_ref().map(|mime| mime.type_().as_str()),
                duration_ms = tracing_duration_ms,
                "Attachment IPC succeeded"
            );
            Ok(())
        }
        Err(error) => {
            // Review fix: a user clicking Cancel mid-upload is expected UX,
            // not a bug — recording it identically to a genuine upload
            // failure (Error-level breadcrumb, warn-level log, an
            // UnknownError span status) made normal cancels indistinguishable
            // from real failures in Sentry/telemetry.
            let cancelled = error == "upload cancelled";
            add_attachment_ipc_breadcrumb(
                if cancelled {
                    sentry::Level::Info
                } else {
                    sentry::Level::Error
                },
                if cancelled { "cancelled" } else { "failed" },
                operation_id.as_deref(),
                breadcrumb_total_bytes,
                breadcrumb_mime.as_ref(),
                Some(duration_ms),
            );
            if cancelled {
                tracing::info!(
                    command = "send_attachment",
                    status = "cancelled",
                    total_bytes = ?breadcrumb_total_bytes,
                    mime_class = ?breadcrumb_mime.as_ref().map(|mime| mime.type_().as_str()),
                    duration_ms = tracing_duration_ms,
                    "Attachment IPC cancelled"
                );
            } else {
                tracing::warn!(
                    command = "send_attachment",
                    status = "failed",
                    total_bytes = ?breadcrumb_total_bytes,
                    mime_class = ?breadcrumb_mime.as_ref().map(|mime| mime.type_().as_str()),
                    duration_ms = tracing_duration_ms,
                    "Attachment IPC failed"
                );
            }
            Err(error)
        }
    };

    if let Some(transaction) = trace_transaction {
        transaction.set_status(match &outcome {
            Ok(_) => sentry::protocol::SpanStatus::Ok,
            Err(error) if error == "upload cancelled" => sentry::protocol::SpanStatus::Cancelled,
            Err(_) => sentry::protocol::SpanStatus::UnknownError,
        });
        transaction.finish();
    }

    outcome
}

/// Cancels an in-flight `send_attachment` call for `txn_id`, if one is still
/// running. A no-op (not an error) if the upload already settled or was never
/// started — the tray row that triggers this can race the upload's own
/// completion, and losing that race just means there's nothing left to
/// cancel.
#[tauri::command]
pub async fn cancel_attachment_upload(
    state: State<'_, MatrixState>,
    txn_id: String,
) -> Result<(), String> {
    if let Some((_room_id, token)) = state
        .attachment_cancellations
        .lock()
        .expect("attachment_cancellations mutex poisoned")
        .get(&txn_id)
    {
        token.cancel();
    }
    Ok(())
}

pub(super) fn cancel_attachment_uploads_for_room(state: &MatrixState, room_id: &RoomId) {
    for (upload_room_id, token) in state
        .attachment_cancellations
        .lock()
        .expect("attachment_cancellations mutex poisoned")
        .values()
    {
        if upload_room_id == room_id {
            token.cancel();
        }
    }
}

/// Fetches (and caches, via matrix-rust-sdk's own `OnceCell`) the
/// homeserver's `m.upload.size` limit, in bytes, so the frontend can warn
/// pre-flight instead of letting an over-limit upload fail opaquely against
/// the server.
#[tauri::command]
pub async fn get_media_config(state: State<'_, MatrixState>) -> Result<u64, String> {
    let client = state.require_client().await?;
    let upload_size = client
        .load_or_fetch_max_upload_size()
        .await
        .map_err(|e| e.to_string())?;
    Ok(i64::from(upload_size) as u64)
}

/// Byte size of a file on disk, so the frontend can run the same
/// `size > maxUploadBytes` pre-flight check for a native desktop attachment
/// (picker/drop payload is a filesystem path string, not a browser `File`
/// with its own `.size`) as it already does for a web upload.
#[tauri::command]
pub async fn get_file_size(file_path: String) -> Result<u64, String> {
    tokio::fs::metadata(&file_path)
        .await
        .map(|metadata| metadata.len())
        .map_err(|e| e.to_string())
}

/// Subscribes to `progress` and forwards each update as an `upload:progress`
/// Tauri event, for as long as the upload is in flight. Runs in its own task
/// so it doesn't block the upload future. The caller owns the returned
/// `JoinHandle` and must `.abort()` it once the upload settles — the
/// subscriber stream does not close on its own because this task holds its
/// own clone of `progress`, so relying on drop of the caller's clone alone
/// would leak the task.
fn spawn_progress_forwarder(
    app: AppHandle,
    progress: SharedObservable<TransmissionProgress>,
    txn_id: String,
    room_id: String,
    total_bytes: u64,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut subscriber = progress.subscribe();
        while let Some(update) = subscriber.next().await {
            let _ = app.emit(
                "upload:progress",
                UploadProgress {
                    txn_id: txn_id.clone(),
                    room_id: room_id.clone(),
                    sent: update.current as u64,
                    total: if update.total > 0 {
                        update.total as u64
                    } else {
                        total_bytes
                    },
                },
            );
        }
    })
}

/// Builds an [`AttachmentInfo`] from the sniffed MIME type and file bytes.
/// Images get real dimensions via the `image` crate; other kinds get a
/// size-only info block (video/audio duration and video dimensions aren't
/// cheaply derivable client-side without a full media-probing dependency,
/// which is out of scope here — the homeserver-side thumbnail endpoint
/// covers the video-thumbnail non-goal called out in the spec).
pub fn attachment_info_for(mime: &mime::Mime, data: &[u8], size_bytes: u64) -> AttachmentInfo {
    let size = matrix_sdk::ruma::UInt::new(size_bytes);

    match mime.type_() {
        mime::IMAGE => {
            let dimensions = image::load_from_memory(data).ok().map(|img| {
                use image::GenericImageView;
                img.dimensions()
            });
            AttachmentInfo::Image(BaseImageInfo {
                height: dimensions.and_then(|(_, h)| matrix_sdk::ruma::UInt::new(h.into())),
                width: dimensions.and_then(|(w, _)| matrix_sdk::ruma::UInt::new(w.into())),
                size,
                blurhash: None,
                is_animated: None,
            })
        }
        mime::VIDEO => AttachmentInfo::Video(matrix_sdk::attachment::BaseVideoInfo {
            duration: None,
            height: None,
            width: None,
            size,
            blurhash: None,
        }),
        mime::AUDIO => AttachmentInfo::Audio(matrix_sdk::attachment::BaseAudioInfo {
            duration: None,
            size,
            waveform: None,
        }),
        _ => AttachmentInfo::File(BaseFileInfo { size }),
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::room_id;

    use super::*;

    #[test]
    fn voice_metadata_preserves_duration_and_normalized_waveform() {
        let metadata = VoiceMessageMetadata {
            duration_ms: 1250,
            waveform: vec![0.0, 0.5, 1.0],
        };
        let info =
            voice_attachment_info(&"audio/ogg; codecs=opus".parse().unwrap(), 1024, &metadata)
                .unwrap();
        let AttachmentInfo::Voice(info) = info else {
            panic!("expected SDK voice path");
        };
        assert_eq!(info.duration, Some(std::time::Duration::from_millis(1250)));
        assert_eq!(info.waveform, Some(metadata.waveform));
    }

    #[test]
    fn voice_metadata_rejects_invalid_waveforms() {
        let mime = "audio/ogg".parse().unwrap();
        for waveform in [
            vec![],
            vec![0.0; 121],
            vec![-0.1],
            vec![1.1],
            vec![f32::NAN],
            vec![f32::INFINITY],
        ] {
            let metadata = VoiceMessageMetadata {
                duration_ms: 1000,
                waveform,
            };
            assert!(voice_attachment_info(&mime, 1024, &metadata).is_err());
        }
    }

    #[test]
    fn voice_metadata_rejects_non_audio_and_out_of_range_duration_or_size() {
        let mime = "audio/ogg".parse().unwrap();
        let mut metadata = VoiceMessageMetadata {
            duration_ms: 1000,
            waveform: vec![0.5],
        };
        assert!(voice_attachment_info(&mime::IMAGE_PNG, 1024, &metadata).is_err());
        for size in [0, MAX_VOICE_RECORDING_UPLOAD_BYTES + 1] {
            assert!(voice_attachment_info(&mime, size, &metadata).is_err());
        }
        for duration in [0, 600_001] {
            metadata.duration_ms = duration;
            assert!(voice_attachment_info(&mime, 1024, &metadata).is_err());
        }
    }

    #[test]
    fn room_barrier_cancels_only_uploads_from_that_room() {
        let state = MatrixState::default();
        let blocked_room = room_id!("!blocked:example.org");
        let other_room = room_id!("!other:example.org");
        let blocked = tokio_util::sync::CancellationToken::new();
        let other = tokio_util::sync::CancellationToken::new();
        {
            let mut uploads = state.attachment_cancellations.lock().unwrap();
            uploads.insert(
                "blocked-upload".to_string(),
                (blocked_room.to_owned(), blocked.clone()),
            );
            uploads.insert(
                "other-upload".to_string(),
                (other_room.to_owned(), other.clone()),
            );
        }

        cancel_attachment_uploads_for_room(&state, blocked_room);

        assert!(blocked.is_cancelled());
        assert!(!other.is_cancelled());
    }

    #[test]
    fn classifies_image_mime_as_image_attachment_info() {
        let mime: mime::Mime = "image/png".parse().unwrap();
        let info = attachment_info_for(&mime, &[], 42);
        assert!(matches!(info, AttachmentInfo::Image(_)));
    }

    #[test]
    fn classifies_unknown_mime_as_file_attachment_info() {
        let mime: mime::Mime = "application/pdf".parse().unwrap();
        let info = attachment_info_for(&mime, &[], 42);
        assert!(matches!(info, AttachmentInfo::File(_)));
    }

    #[test]
    fn classifies_video_mime_as_video_attachment_info() {
        let mime: mime::Mime = "video/mp4".parse().unwrap();
        let info = attachment_info_for(&mime, &[], 42);
        assert!(matches!(info, AttachmentInfo::Video(_)));
    }

    #[test]
    fn classifies_audio_mime_as_audio_attachment_info() {
        let mime: mime::Mime = "audio/ogg".parse().unwrap();
        let info = attachment_info_for(&mime, &[], 42);
        assert!(matches!(info, AttachmentInfo::Audio(_)));
    }

    #[test]
    fn strip_exif_sniffs_jpeg_bytes_despite_wrong_mime() {
        // A camera JPEG picked from a source that reports the wrong (or a
        // generic) MIME type — e.g. a desktop path renamed without `.jpg`,
        // or a web `File` with `application/octet-stream` — must still get
        // stripped, since `strip_exif` now sniffs the actual bytes rather
        // than trusting the caller-supplied MIME alone.
        let img = image::DynamicImage::new_rgb8(4, 4);
        let mut jpeg_bytes = Vec::new();
        img.write_to(
            &mut std::io::Cursor::new(&mut jpeg_bytes),
            image::ImageFormat::Jpeg,
        )
        .unwrap();

        let wrong_mime: mime::Mime = "application/octet-stream".parse().unwrap();
        assert!(strip_exif(&wrong_mime, &jpeg_bytes).is_some());
    }

    #[test]
    fn strip_exif_returns_none_for_non_image_bytes_regardless_of_mime() {
        // A MIME claiming JPEG doesn't make arbitrary bytes decodable —
        // sniffing finds nothing usable, the MIME fallback's decode then
        // fails too, and this must stay `None` rather than panicking.
        let claimed_jpeg_mime: mime::Mime = "image/jpeg".parse().unwrap();
        assert!(strip_exif(&claimed_jpeg_mime, b"not an image").is_none());
    }

    /// Builds a length-prefixed PNG chunk (4-byte length + 4-byte type +
    /// data + a dummy 4-byte CRC) — `is_animated_png` only walks chunk
    /// framing, so a real CRC isn't needed for these tests.
    fn png_chunk(chunk_type: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut chunk = Vec::new();
        chunk.extend_from_slice(&(data.len() as u32).to_be_bytes());
        chunk.extend_from_slice(chunk_type);
        chunk.extend_from_slice(data);
        chunk.extend_from_slice(&[0u8; 4]);
        chunk
    }

    #[test]
    fn is_animated_png_true_when_actl_precedes_idat() {
        let mut data = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
        data.extend(png_chunk(b"IHDR", &[0; 13]));
        data.extend(png_chunk(b"acTL", &[0; 8]));
        data.extend(png_chunk(b"IDAT", &[]));
        assert!(is_animated_png(&data));
    }

    #[test]
    fn is_animated_png_false_when_idat_precedes_any_actl() {
        let mut data = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
        data.extend(png_chunk(b"IHDR", &[0; 13]));
        data.extend(png_chunk(b"IDAT", &[]));
        assert!(!is_animated_png(&data));
    }

    #[test]
    fn is_animated_png_false_for_non_png_bytes() {
        assert!(!is_animated_png(b"not a png"));
    }

    #[test]
    fn strip_exif_skips_animated_png_despite_matching_format() {
        // An APNG is still a well-formed PNG container — `guess_format`
        // alone can't distinguish it from a static one — so without the
        // `is_animated_png` check this would decode-and-re-encode through a
        // single `DynamicImage`, silently collapsing an animated
        // sticker/screenshot to its first frame.
        let mut data = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
        data.extend(png_chunk(b"IHDR", &[0; 13]));
        data.extend(png_chunk(b"acTL", &[0; 8]));
        data.extend(png_chunk(b"IDAT", &[]));

        let mime: mime::Mime = "image/png".parse().unwrap();
        assert!(strip_exif(&mime, &data).is_none());
    }

    #[test]
    fn accepts_synthetic_ipc_operation_ids() {
        assert!(is_valid_ipc_operation_id(
            "ipc-550e8400-e29b-41d4-a716-446655440000"
        ));
        assert!(is_valid_ipc_operation_id("ipc-mkw4k1w-1"));
    }

    #[test]
    fn rejects_non_synthetic_ipc_operation_ids() {
        assert!(!is_valid_ipc_operation_id("@alice:example.org"));
        assert!(!is_valid_ipc_operation_id("!room:example.org"));
        assert!(!is_valid_ipc_operation_id("ipc-"));
        assert!(!is_valid_ipc_operation_id("ipc-with/slash"));
        assert!(!is_valid_ipc_operation_id(&format!(
            "ipc-{}",
            "a".repeat(97)
        )));
    }

    #[test]
    fn build_message_content_without_formatted_body_is_text_plain() {
        let content = build_message_content("hello".to_string(), None, None).unwrap();
        let json = serde_json::to_value(&content).unwrap();
        assert_eq!(json["msgtype"], "m.text");
        assert_eq!(json["body"], "hello");
        assert!(json.get("formatted_body").is_none());
        assert!(json.get("format").is_none());
    }

    #[test]
    fn build_message_content_with_formatted_body_is_text_html() {
        let content = build_message_content(
            "hello".to_string(),
            Some("<strong>hello</strong>".to_string()),
            None,
        )
        .unwrap();
        let json = serde_json::to_value(&content).unwrap();
        assert_eq!(json["msgtype"], "m.text");
        assert_eq!(json["format"], "org.matrix.custom.html");
        assert_eq!(json["formatted_body"], "<strong>hello</strong>");
    }

    #[test]
    fn build_message_content_with_mentions_populates_user_ids() {
        let content = build_message_content(
            "hi @alice".to_string(),
            None,
            Some(vec!["@alice:example.org".to_string()]),
        )
        .unwrap();
        let json = serde_json::to_value(&content).unwrap();
        assert_eq!(json["m.mentions"]["user_ids"][0], "@alice:example.org");
    }

    #[test]
    fn forwarded_content_strips_relates_to() {
        // Same shape check as forward_message_impl's stripping step: build a
        // reply (which carries an m.relates_to/m.in_reply_to relation), then
        // confirm clearing `relates_to` removes it from the serialized JSON
        // entirely, so a forwarded copy never carries the source's relation.
        let metadata = matrix_sdk::ruma::events::room::message::ReplyMetadata::new(
            matrix_sdk::ruma::event_id!("$original:example.org"),
            matrix_sdk::ruma::user_id!("@alice:example.org"),
            None,
        );
        let mut content = RoomMessageEventContent::text_plain("hi back").make_reply_to(
            metadata,
            matrix_sdk::ruma::events::room::message::ForwardThread::No,
            matrix_sdk::ruma::events::room::message::AddMentions::Yes,
        );
        assert!(serde_json::to_value(&content).unwrap()["m.relates_to"].is_object());

        content.relates_to = None;
        let json = serde_json::to_value(&content).unwrap();
        assert!(
            json.get("m.relates_to").is_none(),
            "forwarded content must not carry the source event's m.relates_to"
        );
    }

    #[test]
    fn forwarded_content_strips_mentions() {
        // A reply carries `m.mentions` (added by `make_reply_to`'s
        // `AddMentions::Yes`) pointing at the original sender — forwarding
        // must not carry that mention along, or a room the forwarder never
        // mentioned anyone in would silently notify that user.
        let metadata = matrix_sdk::ruma::events::room::message::ReplyMetadata::new(
            matrix_sdk::ruma::event_id!("$original:example.org"),
            matrix_sdk::ruma::user_id!("@alice:example.org"),
            None,
        );
        let mut content = RoomMessageEventContent::text_plain("hi back").make_reply_to(
            metadata,
            matrix_sdk::ruma::events::room::message::ForwardThread::No,
            matrix_sdk::ruma::events::room::message::AddMentions::Yes,
        );
        assert!(serde_json::to_value(&content).unwrap()["m.mentions"].is_object());

        content.mentions = None;
        let json = serde_json::to_value(&content).unwrap();
        assert!(
            json.get("m.mentions").is_none(),
            "forwarded content must not carry the source event's m.mentions"
        );
    }

    #[test]
    fn latest_effective_replacement_reconciles_server_and_pending_timestamps() {
        let content = |body: &str| {
            let content = RoomMessageEventContent::text_plain(body);
            let json = serde_json::to_value(content).unwrap();
            serde_json::from_value(json).unwrap()
        };
        let server = ServerReplacement {
            transaction_id: None,
            origin_server_ts: 200,
            new_content: content("newer server edit"),
        };
        let older_pending = PendingReplacement {
            transaction_id: "pending-old".to_string(),
            origin_server_ts: 100,
            new_content: content("older pending edit"),
        };

        let selected = latest_effective_replacement(Some(server), vec![older_pending])
            .expect("one replacement should be selected");

        assert_eq!(selected.msgtype.body(), "newer server edit");
    }

    #[test]
    fn forwarded_reply_content_sanitizes_before_clearing_relates_to() {
        // forward_message_impl calls `sanitize` before clearing `relates_to`
        // (not after) because `sanitize`'s reply-fallback stripping only
        // triggers while `relates_to` still says "this is a reply" — see
        // `rooms::room_message_preview_from_raw`'s identical ordering. This
        // ruma version's `make_reply_to` doesn't itself prepend a quoted
        // fallback into `body` (only the `m.in_reply_to` relation — see
        // `actions::make_reply_to_builds_in_reply_to_relation_and_fallback`),
        // so there's nothing to strip today, but the ordering is what makes
        // stripping *possible* if a future ruma version (or a thread
        // fallback) reintroduces one — get it right regardless.
        let metadata = matrix_sdk::ruma::events::room::message::ReplyMetadata::new(
            matrix_sdk::ruma::event_id!("$original:example.org"),
            matrix_sdk::ruma::user_id!("@alice:example.org"),
            None,
        );
        let mut content = RoomMessageEventContent::text_plain("hi back").make_reply_to(
            metadata,
            matrix_sdk::ruma::events::room::message::ForwardThread::No,
            matrix_sdk::ruma::events::room::message::AddMentions::Yes,
        );

        content.sanitize(
            matrix_sdk::ruma::html::HtmlSanitizerMode::Compat,
            matrix_sdk::ruma::html::RemoveReplyFallback::Yes,
        );
        content.relates_to = None;

        assert_eq!(content.body(), "hi back");
    }

    #[test]
    fn build_message_content_rejects_invalid_mention_id() {
        let result = build_message_content(
            "hi".to_string(),
            None,
            Some(vec!["not-a-user-id".to_string()]),
        );
        assert!(result.is_err());
    }
}

/// Exercises `SEND_CAPTURE_LOCK`'s reason for existing. Against a mocked
/// homeserver (no live Synapse needed) via `matrix-sdk-test`'s
/// `MatrixMockServer` — same pattern as `timeline::mapping_tests`.
///
/// Note on what this can and can't prove: `NewLocalEvent` fires as soon as
/// `send()` enqueues the content locally, before the (mocked, artificially
/// delayed in an earlier version of this test) network round trip — so
/// there's no reliable way from outside the function to force the exact
/// subscribe/send/broadcast interleaving `SEND_CAPTURE_LOCK` guards against;
/// that requires genuine OS-thread-level scheduling luck, not just
/// `tokio::join!` on a single task. This test instead locks in the invariant
/// the lock exists to guarantee — concurrent sends resolve to distinct,
/// correctly separated transaction ids — as regression coverage for the
/// currently-correct (locked) behavior.
#[cfg(test)]
mod concurrency_tests {
    use matrix_sdk::ruma::{event_id, room_id};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;

    use super::*;

    #[tokio::test]
    async fn pending_replacement_is_used_before_server_relations() {
        let room_id = room_id!("!test:example.org");
        let event_id = event_id!("$original:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        let room = server.sync_joined_room(&client, room_id).await;
        room.send_queue().set_enabled(false);

        let edit = RoomMessageEventContent::text_plain("edited locally").make_replacement(
            matrix_sdk::ruma::events::room::message::ReplacementMetadata::new(
                event_id.to_owned(),
                None,
            ),
        );
        room.send_queue()
            .send(AnyMessageLikeEventContent::RoomMessage(edit))
            .await
            .unwrap();

        let pending = pending_replacements(&room, event_id)
            .await
            .unwrap()
            .pop()
            .expect("queued edit should be visible before it reaches /relations");

        assert_eq!(pending.new_content.msgtype.body(), "edited locally");
    }

    #[tokio::test]
    async fn concurrent_sends_each_capture_a_distinct_transaction_id() {
        let room_id = room_id!("!test:example.org");
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        server.mock_room_state_encryption().plain().mount().await;
        let room = server.sync_joined_room(&client, room_id).await;

        // Not `.expect(n)`-scoped: both concurrent sends hit this endpoint,
        // and the returned event id isn't what this test is checking (that's
        // the send-queue's own concern) — only that each call's *own*
        // client-generated transaction id is the one it gets back.
        server
            .mock_room_send()
            .ok(matrix_sdk::ruma::event_id!("$fake"))
            .mount()
            .await;

        let content_a = AnyMessageLikeEventContent::RoomMessage(
            build_message_content("message one".to_string(), None, None).unwrap(),
        );
        let content_b = AnyMessageLikeEventContent::RoomMessage(
            build_message_content("message two".to_string(), None, None).unwrap(),
        );

        let (result_a, result_b) = tokio::join!(
            send_and_capture_transaction_id(&client, &room, content_a),
            send_and_capture_transaction_id(&client, &room, content_b),
        );

        let id_a = result_a.expect("first concurrent send should succeed");
        let id_b = result_b.expect("second concurrent send should succeed");

        // The actual bug `SEND_CAPTURE_LOCK` prevents: without it, two
        // overlapping calls could both end up reading the same first
        // `NewLocalEvent` broadcast and return identical ids, misattributing
        // one send's local echo to the other.
        assert_ne!(
            id_a, id_b,
            "two concurrent sends must not capture the same transaction id"
        );
        assert!(!id_a.is_empty());
        assert!(!id_b.is_empty());
    }
}
