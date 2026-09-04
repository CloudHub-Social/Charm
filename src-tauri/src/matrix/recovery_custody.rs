//! Pending recovery credentials stay in existing protected storage until acknowledgement.

pub use async_trait::async_trait;
use matrix_sdk::{encryption::recovery::RecoveryState, Client};
use rand::{distr::Alphanumeric, RngExt};
use serde::{Deserialize, Serialize};
use tauri::State;
use zeroize::{Zeroize, Zeroizing};

use super::secret_store::{SecretEntry, SecretStoreError};
use super::verification::{self, RecoverySetupSummary};
use super::{persistence, MatrixState};

#[derive(Clone, Serialize, Deserialize)]
pub struct PendingRecoverySetup {
    passphrase: String,
    recovery_key: Option<String>,
    room_keys_backed_up: bool,
}

impl std::fmt::Debug for PendingRecoverySetup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PendingRecoverySetup([REDACTED])")
    }
}

impl Drop for PendingRecoverySetup {
    fn drop(&mut self) {
        self.passphrase.zeroize();
        self.recovery_key.zeroize();
    }
}

#[async_trait::async_trait]
pub trait RecoveryCustody: Send + Sync {
    async fn load(&self) -> Result<Option<PendingRecoverySetup>, String>;
    async fn save(&self, pending: Option<&PendingRecoverySetup>) -> Result<(), String>;
    /// Claims the empty pending slot and returns the canonical winner. Web
    /// implementations override this with a cross-process conditional write;
    /// native callers are serialized by the account recovery lock.
    async fn claim(
        &self,
        pending: &PendingRecoverySetup,
    ) -> Result<PendingRecoverySetup, String> {
        self.save(Some(pending)).await?;
        Ok(pending.clone())
    }
    /// Web persists its encrypted crypto database before enabling secret storage.
    async fn checkpoint(&self) -> Result<(), String>;
}

pub async fn pending_summary(
    client: &Client,
    custody: &dyn RecoveryCustody,
) -> Result<Option<RecoverySetupSummary>, String> {
    let Some(pending) = custody.load().await? else {
        return Ok(None);
    };
    if let Some(recovery_key) = &pending.recovery_key {
        return Ok(Some(RecoverySetupSummary {
            recovery_key: recovery_key.clone(),
            room_keys_backed_up: pending.room_keys_backed_up,
        }));
    }
    let storage = client.encryption().secret_storage();
    if !storage
        .is_enabled()
        .await
        .map_err(|_| "Could not read recovery state.")?
    {
        return Ok(None);
    }
    // The seed was committed BEFORE SDK enable. This also recovers a key when
    // the process died between server-side enablement and the local result save.
    let store = storage
        .open_secret_store(&pending.passphrase)
        .await
        .map_err(|_| "Could not reopen pending recovery. Retry when online.")?;
    Ok(Some(RecoverySetupSummary {
        recovery_key: store.secret_storage_key(),
        room_keys_backed_up: false,
    }))
}

pub async fn setup_with_custody(
    client: &Client,
    custody: &dyn RecoveryCustody,
    passphrase: Option<String>,
) -> Result<RecoverySetupSummary, String> {
    let passphrase = passphrase.map(Zeroizing::new);
    verification::validate_recovery_passphrase(passphrase.as_ref().map(|p| p.as_str()))?;
    let existing = custody.load().await?;
    if existing.as_ref().is_some_and(|pending| {
        passphrase
            .as_ref()
            .is_some_and(|requested| requested.as_str() != pending.passphrase)
    }) {
        // The previous seed may already protect server-side secrets. Replacing
        // it on retry could destroy the only way to reopen a partial setup.
        return Err(
            "Pending recovery uses the original passphrase. Retry without a new passphrase.".into(),
        );
    }
    if let Some(summary) = pending_summary(client, custody).await? {
        return Ok(summary);
    }
    let mut pending = match existing {
        Some(pending) => pending,
        None => {
            if client.encryption().recovery().state() != RecoveryState::Disabled {
                return Err("Recovery can only be set up when it is currently disabled.".into());
            }
            let status = verification::cross_signing_status_impl(client).await?;
            if !(status.has_master_key
                && status.has_self_signing_key
                && status.has_user_signing_key)
            {
                return Err("Set up or restore cross-signing before enabling recovery.".into());
            }
            let pending = PendingRecoverySetup {
                passphrase: passphrase
                    .as_ref()
                    .map(|p| p.to_string())
                    .unwrap_or_else(|| {
                        rand::rng()
                            .sample_iter(&Alphanumeric)
                            .take(64)
                            .map(char::from)
                            .collect()
                    }),
                recovery_key: None,
                room_keys_backed_up: false,
            };
            custody.claim(&pending).await?
        }
    };
    custody.checkpoint().await?;
    if !client.encryption().backups().are_enabled().await {
        client
            .encryption()
            .recovery()
            .enable_backup()
            .await
            .map_err(|_| {
                "Could not enable a new backup. Restore an existing backup if one exists."
            })?;
    }
    // Preserve the newly generated backup private key before creating SSSS.
    custody.checkpoint().await?;
    let summary = verification::enable_recovery_impl(client, Some(&pending.passphrase)).await?;
    pending.recovery_key = Some(summary.recovery_key.clone());
    pending.room_keys_backed_up = summary.room_keys_backed_up;
    // If this final write fails, the already-durable seed can reopen SSSS.
    // Do not hide a credential that the SDK has already issued.
    if custody.save(Some(&pending)).await.is_err() {
        tracing::warn!("Pending recovery result save failed; protected seed remains available");
    }
    Ok(summary)
}

pub async fn acknowledge(
    client: &Client,
    custody: &dyn RecoveryCustody,
    recovery_key: String,
) -> Result<(), String> {
    let recovery_key = Zeroizing::new(recovery_key);
    let Some(summary) = pending_summary(client, custody).await? else {
        return Ok(());
    };
    if summary.recovery_key != recovery_key.as_str() {
        return Err("Pending recovery changed. Save the current key before acknowledging.".into());
    }
    custody.save(None).await
}

pub(crate) struct NativeRecoveryCustody {
    account_key: String,
}

impl NativeRecoveryCustody {
    pub(crate) fn for_client(client: &Client) -> Result<Self, String> {
        let user_id = client.user_id().ok_or("Not signed in.")?;
        Ok(Self {
            account_key: persistence::account_key(user_id.as_str()),
        })
    }
}

fn entry(account_key: &str) -> Result<SecretEntry, String> {
    SecretEntry::new(
        "social.cloudhub.charm",
        &format!("pending-recovery:{account_key}"),
    )
    .map_err(|_| "Protected recovery storage is unavailable.".into())
}

pub(crate) fn clear_native_pending(account_key: &str) -> Result<(), String> {
    match entry(account_key)?.delete_credential() {
        Ok(()) | Err(SecretStoreError::NotFound) => Ok(()),
        Err(_) => Err("Could not clear pending recovery from protected storage.".into()),
    }
}

#[async_trait::async_trait]
impl RecoveryCustody for NativeRecoveryCustody {
    async fn load(&self) -> Result<Option<PendingRecoverySetup>, String> {
        let key = self.account_key.clone();
        tokio::task::spawn_blocking(move || match entry(&key)?.get_password() {
            Ok(value) => serde_json::from_str(&Zeroizing::new(value))
                .map(Some)
                .map_err(|_| "Protected recovery record could not be read.".into()),
            Err(SecretStoreError::NotFound) => Ok(None),
            Err(_) => Err("Protected recovery storage is unavailable.".into()),
        })
        .await
        .map_err(|_| "Protected recovery storage failed.".to_string())?
    }

    async fn save(&self, pending: Option<&PendingRecoverySetup>) -> Result<(), String> {
        let value = pending
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| "Could not encode the pending recovery record.")?
            .map(Zeroizing::new);
        let key = self.account_key.clone();
        tokio::task::spawn_blocking(move || {
            let entry = entry(&key)?;
            match value {
                Some(value) => entry
                    .set_password(&value)
                    .map_err(|_| "Could not save pending recovery in protected storage.".into()),
                None => match entry.delete_credential() {
                    Ok(()) | Err(SecretStoreError::NotFound) => Ok(()),
                    Err(_) => Err("Could not acknowledge pending recovery.".into()),
                },
            }
        })
        .await
        .map_err(|_| "Protected recovery storage failed.".to_string())?
    }

    async fn checkpoint(&self) -> Result<(), String> {
        Ok(())
    }
}

#[tauri::command]
pub async fn get_pending_recovery_setup(
    state: State<'_, MatrixState>,
) -> Result<Option<RecoverySetupSummary>, String> {
    let _guard = state.login_completion_lock.lock().await;
    let client = state.require_client().await?;
    pending_summary(&client, &NativeRecoveryCustody::for_client(&client)?).await
}

#[tauri::command]
pub async fn acknowledge_recovery_setup(
    state: State<'_, MatrixState>,
    recovery_key: String,
) -> Result<(), String> {
    let _guard = state.login_completion_lock.lock().await;
    let client = state.require_client().await?;
    acknowledge(
        &client,
        &NativeRecoveryCustody::for_client(&client)?,
        recovery_key,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct MemoryCustody {
        pending: Mutex<Option<PendingRecoverySetup>>,
        fail_save: bool,
    }

    #[async_trait]
    impl RecoveryCustody for MemoryCustody {
        async fn load(&self) -> Result<Option<PendingRecoverySetup>, String> {
            Ok(self.pending.lock().unwrap().clone())
        }
        async fn save(&self, pending: Option<&PendingRecoverySetup>) -> Result<(), String> {
            if self.fail_save {
                return Err("protected storage unavailable".into());
            }
            *self.pending.lock().unwrap() = pending.cloned();
            Ok(())
        }
        async fn checkpoint(&self) -> Result<(), String> {
            Ok(())
        }
    }

    fn pending() -> PendingRecoverySetup {
        PendingRecoverySetup {
            passphrase: "private seed".into(),
            recovery_key: Some("issued key".into()),
            room_keys_backed_up: true,
        }
    }

    #[tokio::test]
    async fn issued_key_reopens_offline_and_only_matching_acknowledgement_removes_it() {
        let client = Client::builder()
            .homeserver_url("http://127.0.0.1:9")
            .build()
            .await
            .unwrap();
        let custody = MemoryCustody {
            pending: Mutex::new(Some(pending())),
            fail_save: false,
        };
        assert_eq!(
            pending_summary(&client, &custody)
                .await
                .unwrap()
                .unwrap()
                .recovery_key,
            "issued key"
        );
        assert!(acknowledge(&client, &custody, "other key".into())
            .await
            .is_err());
        assert!(custody.load().await.unwrap().is_some());
        acknowledge(&client, &custody, "issued key".into())
            .await
            .unwrap();
        assert!(pending_summary(&client, &custody).await.unwrap().is_none());
        acknowledge(&client, &custody, "issued key".into())
            .await
            .unwrap();
        assert!(custody.load().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn retry_rejects_a_different_passphrase_without_changing_custody() {
        let client = Client::builder()
            .homeserver_url("http://127.0.0.1:9")
            .build()
            .await
            .unwrap();
        let custody = MemoryCustody {
            pending: Mutex::new(Some(pending())),
            fail_save: false,
        };
        assert!(
            setup_with_custody(&client, &custody, Some("different phrase".into()))
                .await
                .is_err()
        );
        assert_eq!(
            custody.load().await.unwrap().unwrap().passphrase,
            "private seed"
        );
        assert_eq!(
            setup_with_custody(&client, &custody, None)
                .await
                .unwrap()
                .recovery_key,
            "issued key"
        );
    }

    #[tokio::test]
    async fn failed_acknowledgement_preserves_the_pending_key() {
        let client = Client::builder()
            .homeserver_url("http://127.0.0.1:9")
            .build()
            .await
            .unwrap();
        let custody = MemoryCustody {
            pending: Mutex::new(Some(pending())),
            fail_save: true,
        };
        assert!(acknowledge(&client, &custody, "issued key".into())
            .await
            .is_err());
        assert_eq!(
            pending_summary(&client, &custody)
                .await
                .unwrap()
                .unwrap()
                .recovery_key,
            "issued key"
        );
    }

    #[test]
    fn pending_debug_is_redacted_and_protected_record_round_trips() {
        let pending = pending();
        assert_eq!(format!("{pending:?}"), "PendingRecoverySetup([REDACTED])");
        let encoded = Zeroizing::new(serde_json::to_string(&pending).unwrap());
        let decoded: PendingRecoverySetup = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.passphrase, pending.passphrase);
        assert_eq!(decoded.recovery_key, pending.recovery_key);
    }
}
