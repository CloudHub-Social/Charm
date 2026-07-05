use std::path::Path;

use eyeball::SharedObservable;
use matrix_sdk::attachment::{AttachmentConfig, AttachmentInfo, BaseFileInfo, BaseImageInfo};
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::events::AnyMessageLikeEventContent;
use matrix_sdk::ruma::RoomId;
use matrix_sdk::TransmissionProgress;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use ts_rs::TS;

use super::MatrixState;

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

/// Queues a plain-text message for sending via matrix-rust-sdk's send queue.
/// This returns as soon as the event is queued, not once the homeserver has
/// accepted it — the send queue handles the network round-trip, retries, and
/// offline queueing on its own. No local-echo event is pushed back to the
/// frontend yet; callers currently re-fetch the timeline page after sending.
#[tauri::command]
pub async fn send_message(
    state: State<'_, MatrixState>,
    room_id: String,
    body: String,
) -> Result<(), String> {
    let client = state.require_client().await?;

    let parsed_room_id = RoomId::parse(&room_id).map_err(|e| e.to_string())?;
    let room = client
        .get_room(&parsed_room_id)
        .ok_or_else(|| format!("room {room_id} not found"))?;

    let content =
        AnyMessageLikeEventContent::RoomMessage(RoomMessageEventContent::text_plain(body));
    room.send_queue()
        .send(content)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
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
    room_id: String,
    file_path: String,
    caption: Option<String>,
    txn_id: String,
) -> Result<(), String> {
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

    let data = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
    let total_bytes = data.len() as u64;
    let mime = mime_guess::from_path(path).first_or_octet_stream();

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

    result.map(|_| ()).map_err(|e| e.to_string())
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
fn attachment_info_for(mime: &mime::Mime, data: &[u8], size_bytes: u64) -> AttachmentInfo {
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
}
