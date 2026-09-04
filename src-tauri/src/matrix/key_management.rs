//! User-mediated encrypted room-key file import/export (Spec 44).
//!
//! File paths never cross the frontend IPC boundary. Each command opens its
//! own native picker and operates only on the exact path the user selected,
//! which avoids turning a compromised webview into an arbitrary file reader
//! or writer. Passphrases are bounded before reaching matrix-sdk and are never
//! logged. matrix-sdk owns the interoperable encrypted key-file format and
//! zeroizes its Rust-side passphrase copy.

use std::path::PathBuf;

use matrix_sdk::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, FileAccessMode, FilePath, PickerMode};
use ts_rs::TS;

use super::MatrixState;

const MIN_PASSPHRASE_CHARS: usize = 8;
const MAX_PASSPHRASE_BYTES: usize = 1024;
const MAX_IMPORT_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RoomKeyExportSummary {
    pub completed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../src/bindings/")]
pub struct RoomKeyImportSummary {
    pub completed: bool,
    #[ts(type = "number")]
    pub imported_count: usize,
    #[ts(type = "number")]
    pub total_count: usize,
}

fn validate_passphrase(passphrase: &str, exporting: bool) -> Result<(), String> {
    // Existing files may use short or empty passphrases. Strength requirements
    // apply only when creating a new export, never when decrypting an old one.
    if exporting && passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(format!(
            "Passphrase must be at least {MIN_PASSPHRASE_CHARS} characters."
        ));
    }
    if passphrase.len() > MAX_PASSPHRASE_BYTES {
        return Err("Passphrase is too long.".to_string());
    }
    Ok(())
}

fn feature_enabled(app: &AppHandle) -> bool {
    app.path().app_data_dir().is_ok_and(|directory| {
        crate::feature_flags::flag(
            &directory,
            crate::feature_flags::FeatureFlagKey::CryptoKeyFiles,
        )
    })
}

fn require_transfer_identity<'a>(
    active: Option<&'a Client>,
    expected: &Client,
) -> Result<&'a Client, String> {
    active
        .filter(|active| {
            expected.user_id().is_some()
                && expected.device_id().is_some()
                && active.user_id() == expected.user_id()
                && active.device_id() == expected.device_id()
        })
        .ok_or_else(|| "The active session changed. Start the key transfer again.".to_string())
}

async fn run_key_transfer<T, F, Fut>(
    app: AppHandle,
    expected: Client,
    transfer: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(Client) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<T, String>> + Send,
{
    // No lock is held while the picker is open. Once admitted, keep logout or
    // replacement from clearing the active client until SDK file work finishes.
    // A dropped invoke must not release exclusion while the SDK's blocking
    // encryption/write task continues, so this task owns the guard independently.
    tokio::spawn(async move {
        let state = app.state::<MatrixState>();
        let active = state.client.lock().await;
        let client = require_transfer_identity(active.as_ref(), &expected)?.clone();
        if !feature_enabled(&app) {
            return Err("Room-key file import and export are not enabled.".to_string());
        }
        let result = transfer(client).await;
        drop(active);
        result
    })
    .await
    .map_err(|_| "The room-key transfer could not finish.".to_string())?
}

async fn receive_selected_path(
    register: impl FnOnce(Box<dyn FnOnce(Option<FilePath>) + Send>),
) -> Result<Option<PathBuf>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    register(Box::new(move |selection| {
        let _ = sender.send(selection);
    }));
    let Some(selection) = receiver
        .await
        .map_err(|_| "The native file picker closed unexpectedly.".to_string())?
    else {
        return Ok(None);
    };
    selection
        .into_path()
        .map(Some)
        .map_err(|_| "The selected item is not an accessible local file.".to_string())
}

async fn pick_import_path(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let picker = app
        .dialog()
        .file()
        .set_title("Import encrypted Matrix room keys")
        .add_filter("Matrix room keys", &["txt"])
        .set_picker_mode(PickerMode::Document)
        .set_file_access_mode(FileAccessMode::Copy);
    receive_selected_path(|callback| picker.pick_file(callback)).await
}

async fn pick_export_path(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let picker = app
        .dialog()
        .file()
        .set_title("Export encrypted Matrix room keys")
        .set_file_name("charm-room-keys.txt")
        .add_filter("Matrix room keys", &["txt"])
        .set_picker_mode(PickerMode::Document)
        .set_file_access_mode(FileAccessMode::Copy);
    receive_selected_path(|callback| picker.save_file(callback)).await
}

#[tauri::command]
pub async fn export_room_keys(
    app: AppHandle,
    state: State<'_, MatrixState>,
    passphrase: String,
) -> Result<RoomKeyExportSummary, String> {
    let passphrase = zeroize::Zeroizing::new(passphrase);
    if !feature_enabled(&app) {
        return Err("Room-key file import and export are not enabled.".to_string());
    }
    validate_passphrase(&passphrase, true)?;
    let client = state.require_client().await?;
    let Some(path) = pick_export_path(&app).await? else {
        return Ok(RoomKeyExportSummary { completed: false });
    };

    run_key_transfer(app, client, move |client| async move {
        client
            .encryption()
            .export_room_keys(path, &passphrase, |_| true)
            .await
            .map_err(|_| "Could not export room keys to the selected file.".to_string())?;
        tracing::info!("encrypted room-key export completed");
        Ok(RoomKeyExportSummary { completed: true })
    })
    .await
}

#[tauri::command]
pub async fn import_room_keys(
    app: AppHandle,
    state: State<'_, MatrixState>,
    passphrase: String,
) -> Result<RoomKeyImportSummary, String> {
    let passphrase = zeroize::Zeroizing::new(passphrase);
    if !feature_enabled(&app) {
        return Err("Room-key file import and export are not enabled.".to_string());
    }
    validate_passphrase(&passphrase, false)?;
    let client = state.require_client().await?;
    let Some(path) = pick_import_path(&app).await? else {
        return Ok(RoomKeyImportSummary {
            completed: false,
            imported_count: 0,
            total_count: 0,
        });
    };
    let metadata = tokio::task::spawn_blocking({
        let path = path.clone();
        move || std::fs::metadata(path)
    })
    .await
    .map_err(|_| "Could not inspect the selected room-key file.".to_string())?
    .map_err(|_| "Could not read the selected room-key file.".to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_IMPORT_BYTES {
        return Err("The selected room-key file is invalid or larger than 100 MB.".to_string());
    }

    run_key_transfer(app, client, move |client| async move {
        let result = client
            .encryption()
            .import_room_keys(path, &passphrase)
            .await
            .map_err(|_| {
                "Could not decrypt the room-key file. Check the file and passphrase.".to_string()
            })?;
        tracing::info!(
            imported_count = result.imported_count,
            total_count = result.total_count,
            "encrypted room-key import completed"
        );
        Ok(RoomKeyImportSummary {
            completed: true,
            imported_count: result.imported_count,
            total_count: result.total_count,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passphrase_validation_is_bounded() {
        assert!(validate_passphrase("correct horse battery staple", true).is_ok());
        assert!(validate_passphrase("short", true).is_err());
        assert!(validate_passphrase("", true).is_err());
        assert!(validate_passphrase("short", false).is_ok());
        assert!(validate_passphrase("", false).is_ok());
        assert!(validate_passphrase(&"🔑".repeat(4), true).is_err());
        assert!(validate_passphrase(&"🔑".repeat(8), true).is_ok());
        for exporting in [true, false] {
            assert!(validate_passphrase(&"🔑".repeat(256), exporting).is_ok());
            assert!(validate_passphrase(&"🔑".repeat(257), exporting).is_err());
            assert!(validate_passphrase(&"x".repeat(MAX_PASSPHRASE_BYTES + 1), exporting).is_err());
        }
    }

    #[tokio::test]
    async fn transfer_rejects_logout_or_changed_account_or_device() {
        use matrix_sdk::ruma::{device_id, user_id};
        use matrix_sdk::test_utils::mocks::MatrixMockServer;

        let server = MatrixMockServer::new().await;
        let expected = server.client_builder().build().await;
        assert!(require_transfer_identity(Some(&expected), &expected).is_ok());
        assert!(require_transfer_identity(None, &expected).is_err());
        let other_account = server
            .client_builder()
            .logged_in_with_token(
                "test-only".into(),
                user_id!("@other:localhost").to_owned(),
                expected.device_id().unwrap().to_owned(),
            )
            .build()
            .await;
        assert!(require_transfer_identity(Some(&other_account), &expected).is_err());
        let other_device = server
            .client_builder()
            .logged_in_with_token(
                "test-only".into(),
                expected.user_id().unwrap().to_owned(),
                device_id!("OTHER_DEVICE").to_owned(),
            )
            .build()
            .await;
        assert!(require_transfer_identity(Some(&other_device), &expected).is_err());
    }
}
