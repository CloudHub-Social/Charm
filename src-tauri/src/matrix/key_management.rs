//! User-mediated encrypted room-key file import/export (Spec 44).
//!
//! File paths never cross the frontend IPC boundary. Each command opens its
//! own native picker and operates only on the exact path the user selected,
//! which avoids turning a compromised webview into an arbitrary file reader
//! or writer. Passphrases are bounded before reaching matrix-sdk and are never
//! logged. matrix-sdk owns the interoperable encrypted key-file format and
//! zeroizes its Rust-side passphrase copy.

use std::io::Read;
use std::path::{Path, PathBuf};

use base64::Engine;
use matrix_sdk::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, FileAccessMode, FilePath, PickerMode};
use ts_rs::TS;

use super::MatrixState;

const MIN_PASSPHRASE_CHARS: usize = 8;
const MAX_PASSPHRASE_BYTES: usize = 1024;
const MAX_IMPORT_BYTES: u64 = 100 * 1024 * 1024;
const MAX_IMPORT_KDF_ROUNDS: u32 = 1_000_000;

fn validate_import_cost(path: &Path) -> Result<(), String> {
    // Resource policy only: the SDK remains the format/MAC/decryption owner.
    // This reads the already-bounded private snapshot, before client admission.
    const HEADER: &str = "-----BEGIN MEGOLM SESSION DATA-----";
    const FOOTER: &str = "-----END MEGOLM SESSION DATA-----";
    let invalid = || "The selected encrypted room-key file is invalid.".to_string();
    let input = std::fs::read_to_string(path).map_err(|_| invalid())?;
    if !input.trim_start().starts_with(HEADER) || !input.trim_end().ends_with(FOOTER) {
        return Err(invalid());
    }
    let payload: String = input
        .lines()
        .filter(|line| !(line.starts_with(HEADER) || line.starts_with(FOOTER)))
        .collect();
    let decoded = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(&payload)
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(&payload))
        .map_err(|_| invalid())?;
    // Version + 16-byte salt + 16-byte IV + big-endian rounds + 32-byte MAC.
    if decoded.len() < 69 || decoded[0] != 1 {
        return Err(invalid());
    }
    let rounds = u32::from_be_bytes(decoded[33..37].try_into().map_err(|_| invalid())?);
    if rounds == 0 || rounds > MAX_IMPORT_KDF_ROUNDS {
        return Err("The room-key file uses an unsupported password-derivation cost (maximum 1,000,000 rounds).".into());
    }
    Ok(())
}

fn snapshot_import_file(
    path: &Path,
    limit: u64,
) -> Result<(tempfile::NamedTempFile, tempfile::TempDir), String> {
    // Inspect the opened descriptor, then bound the actual read. Path metadata
    // alone cannot constrain a file changed between inspection and SDK import.
    let source = std::fs::File::open(path)
        .map_err(|_| "Could not read the selected room-key file.".to_string())?;
    let metadata = source
        .metadata()
        .map_err(|_| "Could not inspect the selected room-key file.".to_string())?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("The selected room-key file is invalid or larger than 100 MB.".to_string());
    }
    let directory = tempfile::tempdir()
        .map_err(|_| "Could not prepare the encrypted room-key import.".to_string())?;
    let mut snapshot = tempfile::NamedTempFile::new_in(directory.path())
        .map_err(|_| "Could not prepare the encrypted room-key import.".to_string())?;
    copy_bounded_import(source, snapshot.as_file_mut(), limit)?;
    // Only encrypted bytes reach this private temporary file. Both owners stay
    // alive until the SDK finishes, including when the invoking future drops.
    Ok((snapshot, directory))
}

fn copy_bounded_import(
    source: impl Read,
    destination: &mut impl std::io::Write,
    limit: u64,
) -> Result<(), String> {
    let copied = std::io::copy(&mut source.take(limit.saturating_add(1)), destination)
        .map_err(|_| "Could not read the selected room-key file.".to_string())?;
    if copied > limit {
        return Err("The selected room-key file is invalid or larger than 100 MB.".to_string());
    }
    Ok(())
}

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
        // Share #490's teardown/adoption exclusion before reading identity:
        // a picker returning during awaited logout cleanup must wait until
        // the session is detached, then fail identity validation.
        let _completion_guard = state.login_completion_lock.lock().await;
        let active = state.client.lock().await;
        let client = require_transfer_identity(active.as_ref(), &expected)?.clone();
        drop(active);
        if !feature_enabled(&app) {
            return Err("Room-key file import and export are not enabled.".to_string());
        }
        transfer(client).await
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
    #[cfg(target_os = "android")]
    {
        let _ = app;
        return Err(
            "Room-key file import is unavailable on Android until bounded content-URI streaming is supported."
                .to_string(),
        );
    }
    #[cfg(not(target_os = "android"))]
    let picker = app
        .dialog()
        .file()
        .set_title("Import encrypted Matrix room keys")
        .add_filter("Matrix room keys", &["txt"])
        .set_picker_mode(PickerMode::Document)
        // iOS UIDocumentPicker can keep security-scoped, in-place access to
        // the selected document. Avoid the plugin's eager sandbox copy so our
        // descriptor-bounded snapshot is the first and only copy.
        .set_file_access_mode(FileAccessMode::Scoped);
    #[cfg(not(target_os = "android"))]
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
    let snapshot = tokio::task::spawn_blocking(move || {
        let snapshot = snapshot_import_file(&path, MAX_IMPORT_BYTES)?;
        validate_import_cost(snapshot.0.path())?;
        Ok::<_, String>(snapshot)
    })
    .await
    .map_err(|_| "Could not prepare the encrypted room-key import.".to_string())??;

    run_key_transfer(app, client, move |client| async move {
        let result = client
            .encryption()
            .import_room_keys(snapshot.0.path().to_path_buf(), &passphrase)
            .await
            .map_err(|_| {
                "Could not decrypt the room-key file. Check the file and passphrase.".to_string()
            })?;
        drop(snapshot);
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
    fn import_kdf_cost_is_bounded_before_sdk_decryption() {
        let file = tempfile::NamedTempFile::new().unwrap();
        for (rounds, allowed) in [
            (0_u32, false),
            (500_000, true),
            (1_000_000, true),
            (1_000_001, false),
            (u32::MAX, false),
        ] {
            let mut bytes = vec![0_u8; 69];
            bytes[0] = 1;
            bytes[33..37].copy_from_slice(&rounds.to_be_bytes());
            let encoded = base64::engine::general_purpose::STANDARD_NO_PAD.encode(bytes);
            std::fs::write(file.path(), format!("-----BEGIN MEGOLM SESSION DATA-----\n{encoded}\n-----END MEGOLM SESSION DATA-----")).unwrap();
            assert_eq!(validate_import_cost(file.path()).is_ok(), allowed);
        }
        std::fs::write(
            file.path(),
            "-----BEGIN MEGOLM SESSION DATA-----\nAQ\n-----END MEGOLM SESSION DATA-----",
        )
        .unwrap();
        assert!(validate_import_cost(file.path()).is_err());
    }

    #[test]
    fn import_read_limit_applies_to_growing_or_unending_input() {
        let mut output = Vec::new();
        assert!(copy_bounded_import(std::io::repeat(0), &mut output, 8).is_err());
        assert_eq!(output.len(), 9);
        output.clear();
        assert!(copy_bounded_import(&b"12345678"[..], &mut output, 8).is_ok());
    }

    #[test]
    fn import_snapshot_does_not_follow_later_source_changes() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("keys.txt");
        std::fs::write(&source, b"encrypted-original").unwrap();
        let snapshot = snapshot_import_file(&source, 64).unwrap();
        std::fs::write(&source, b"replacement").unwrap();
        assert_eq!(
            std::fs::read(snapshot.0.path()).unwrap(),
            b"encrypted-original"
        );
        assert!(snapshot_import_file(directory.path(), 64).is_err());
    }

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
