use std::path::Path;
use std::sync::LazyLock;
use std::time::Instant;

use eyeball::SharedObservable;
use matrix_sdk::attachment::{AttachmentConfig, AttachmentInfo, BaseFileInfo, BaseImageInfo};
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::events::{AnyMessageLikeEventContent, Mentions};
use matrix_sdk::ruma::{OwnedUserId, RoomId, UserId};
use matrix_sdk::send_queue::RoomSendQueueUpdate;
use matrix_sdk::TransmissionProgress;
use matrix_sdk::{Client, Room};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::broadcast::error::RecvError;
use ts_rs::TS;

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
    total_bytes: u64,
    mime: &mime::Mime,
    duration_ms: Option<u128>,
) {
    let mut data = sentry::protocol::Map::new();
    data.insert("command".into(), serde_json::json!("send_attachment"));
    data.insert("status".into(), serde_json::json!(status));
    data.insert("total_bytes".into(), serde_json::json!(total_bytes));
    data.insert("mime_type".into(), serde_json::json!(mime.type_().as_str()));
    if let Some(operation_id) = operation_id {
        data.insert("operation_id".into(), serde_json::json!(operation_id));
    }
    if let Some(duration_ms) = duration_ms {
        data.insert("duration_ms".into(), serde_json::json!(duration_ms));
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
static SEND_CAPTURE_LOCK: LazyLock<tokio::sync::Mutex<()>> =
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
pub async fn send_attachment(
    app: AppHandle,
    state: State<'_, MatrixState>,
    request: tauri::ipc::Request<'_>,
    room_id: String,
    file_path: String,
    caption: Option<String>,
    txn_id: String,
) -> Result<(), String> {
    let operation_id = ipc_operation_id(&request);
    let started_at = Instant::now();
    let client = state.require_client().await?;

    let parsed_room_id = RoomId::parse(&room_id).map_err(|e| e.to_string())?;
    let room = client
        .get_room(&parsed_room_id)
        .ok_or_else(|| format!("room {room_id} not found"))?;

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
    let total_bytes = data.len() as u64;
    let mime = mime_guess::from_path(path).first_or_octet_stream();

    add_attachment_ipc_breadcrumb(
        sentry::Level::Info,
        "started",
        operation_id.as_deref(),
        total_bytes,
        &mime,
        None,
    );

    // Caller-supplied, not server-generated: the frontend creates its
    // optimistic upload row (keyed on a locally generated ID) before
    // invoking this command, so this command must reuse that same ID for
    // its `upload:progress` events rather than minting its own — otherwise
    // the two sides can never correlate and the progress bar never updates.
    let txn_id_string = txn_id.clone();
    let ruma_txn_id: matrix_sdk::ruma::OwnedTransactionId = txn_id.into();

    let info = attachment_info_for(&mime, &data, total_bytes);

    let mut config = AttachmentConfig::new().txn_id(ruma_txn_id).info(info);
    if let Some(caption) = caption {
        config = config.caption(Some(
            matrix_sdk::ruma::events::room::message::TextMessageEventContent::plain(caption),
        ));
    }

    let progress = SharedObservable::<TransmissionProgress>::new(TransmissionProgress::default());
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

    let result = send.await;
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

    let duration_ms = started_at.elapsed().as_millis();
    match result {
        Ok(_) => {
            add_attachment_ipc_breadcrumb(
                sentry::Level::Info,
                "succeeded",
                operation_id.as_deref(),
                total_bytes,
                &mime,
                Some(duration_ms),
            );
            Ok(())
        }
        Err(error) => {
            add_attachment_ipc_breadcrumb(
                sentry::Level::Error,
                "failed",
                operation_id.as_deref(),
                total_bytes,
                &mime,
                Some(duration_ms),
            );
            Err(error.to_string())
        }
    }
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
    use super::*;

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
    use matrix_sdk::ruma::room_id;
    use matrix_sdk::test_utils::mocks::MatrixMockServer;

    use super::*;

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
