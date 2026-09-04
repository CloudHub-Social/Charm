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
    #[serde(default)]
    server_mutation_started: bool,
}

impl PendingRecoverySetup {
    pub fn has_issued_key(&self) -> bool {
        self.recovery_key.is_some()
    }

    pub fn requires_custody(&self) -> bool {
        self.server_mutation_started || self.has_issued_key()
    }

    pub fn has_same_issued_key(&self, other: &Self) -> bool {
        self.recovery_key.is_some() && self.recovery_key == other.recovery_key
    }
}

fn secret_storage_error_is_definitively_stale(
    error: &matrix_sdk::encryption::secret_storage::SecretStorageError,
) -> bool {
    matches!(
        error,
        matrix_sdk::encryption::secret_storage::SecretStorageError::SecretStorageKey(_)
            | matrix_sdk::encryption::secret_storage::SecretStorageError::MissingKeyInfo { .. }
    )
}

pub async fn issued_key_is_stale(
    client: &Client,
    pending: &PendingRecoverySetup,
) -> Result<bool, String> {
    let Some(recovery_key) = &pending.recovery_key else {
        return Ok(false);
    };
    match client
        .encryption()
        .secret_storage()
        .open_secret_store(recovery_key)
        .await
    {
        Ok(_) => Ok(false),
        Err(error) if secret_storage_error_is_definitively_stale(&error) => Ok(true),
        Err(_) => Err("Could not validate pending recovery. Retry when online.".into()),
    }
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
    /// Persists a setup result while proving this request still owns the
    /// distributed mutation slot. Native custody is process-serialized.
    async fn save_claimed(&self, pending: &PendingRecoverySetup) -> Result<(), String> {
        self.save(Some(pending)).await
    }
    /// Clears a definitive no-op result while proving this request still
    /// owns the distributed mutation slot.
    async fn clear_claimed(&self) -> Result<(), String> {
        self.save(None).await
    }
    /// Claims the empty pending slot and returns the canonical winner. Web
    /// implementations override this with a cross-process conditional write;
    /// native callers are serialized by the account recovery lock.
    async fn claim(&self, pending: &PendingRecoverySetup) -> Result<PendingRecoverySetup, String> {
        self.save(Some(pending)).await?;
        Ok(pending.clone())
    }
    /// Releases cross-process setup admission after success or failure.
    async fn release(&self) -> Result<(), String> {
        Ok(())
    }
    /// Renews cross-process admission while a potentially long SDK mutation
    /// is still running. Native custody is process-serialized and needs no-op.
    async fn renew(&self) -> Result<(), String> {
        Ok(())
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
    let storage = client.encryption().secret_storage();
    if let Some(recovery_key) = &pending.recovery_key {
        // A different Matrix client can replace the account's default secret
        // storage after this device generated its key. Reopen the *current*
        // default store before displaying or acknowledging the cached value;
        // `open_secret_store` validates the key against the current key event,
        // so stale custody can never be mistaken for a usable credential.
        match storage.open_secret_store(recovery_key).await {
            Ok(_) => {}
            Err(error) if secret_storage_error_is_definitively_stale(&error) => {
                return Err("Pending recovery no longer matches the account's current secret storage. Restart recovery setup.".into());
            }
            Err(_) => return Err("Could not validate pending recovery. Retry when online.".into()),
        }
        return Ok(Some(RecoverySetupSummary {
            recovery_key: recovery_key.clone(),
            room_keys_backed_up: pending.room_keys_backed_up,
        }));
    }
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
    let room_keys_backed_up = client.encryption().backups().are_enabled().await;
    Ok(Some(RecoverySetupSummary {
        recovery_key: store.secret_storage_key(),
        room_keys_backed_up,
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
    let pending = match existing {
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
                server_mutation_started: false,
            };
            pending
        }
    };
    let mut pending = custody.claim(&pending).await?;
    let resumed_after_server_mutation = pending.server_mutation_started;
    let operation = async {
        custody.checkpoint().await?;
        // From this point onward an SDK call can create or replace remote
        // recovery state. Persist the custody boundary first so cancellation,
        // a failed follow-up checkpoint, or a failed result write cannot make
        // logout delete the crypto store that can finish the operation.
        pending.server_mutation_started = true;
        custody.save_claimed(&pending).await?;
        if !client.encryption().backups().are_enabled().await {
            match client.encryption().recovery().enable_backup().await {
                Ok(()) => {}
                Err(matrix_sdk::encryption::recovery::RecoveryError::BackupExistsOnServer) => {
                    if resumed_after_server_mutation {
                        // A prior attempt may have created this backup before
                        // its post-mutation checkpoint completed. Preserve the
                        // protected seed and teardown veto rather than
                        // misclassifying our own partial mutation as a
                        // pre-existing backup and destroying its custody.
                        return Err(
                            "An interrupted recovery setup may have created the existing backup. \
                             Protected recovery state was retained; finish or repair recovery \
                             before signing out."
                                .into(),
                        );
                    }
                    // This attempt observed BackupExists without changing the
                    // server. Clear its no-op seed. If the atomic deletion
                    // itself transiently fails, at least persist that no
                    // mutation occurred so releasing the claim cannot trap
                    // logout behind a credential that was never created.
                    if custody.clear_claimed().await.is_err() {
                        pending.server_mutation_started = false;
                        custody.save_claimed(&pending).await?;
                    }
                    return Err(
                        "A server-side key backup already exists. Restore the existing recovery \
                         instead."
                            .into(),
                    );
                }
                Err(_) => {
                    return Err(
                        "Could not enable a new backup. Restore an existing backup if one exists."
                            .into(),
                    );
                }
            }
        }
        // Preserve the newly generated backup private key before creating SSSS.
        custody.checkpoint().await?;
        let summary = verification::enable_recovery_impl(client, Some(&pending.passphrase)).await?;
        pending.recovery_key = Some(summary.recovery_key.clone());
        pending.room_keys_backed_up = summary.room_keys_backed_up;
        // If this final write fails, the already-durable seed can reopen SSSS.
        // Do not hide a credential that the SDK has already issued.
        if custody.save_claimed(&pending).await.is_err() {
            tracing::warn!("Pending recovery result save failed; protected seed remains available");
        }
        Ok(summary)
    };
    tokio::pin!(operation);
    let result = loop {
        tokio::select! {
            result = &mut operation => break result,
            _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {
                if let Err(error) = custody.renew().await {
                    break Err(error);
                }
            }
        }
    };
    let release = custody.release().await;
    match (result, release) {
        (Ok(summary), Ok(())) => Ok(summary),
        (Err(error), _) => Err(error),
        (Ok(summary), Err(error)) => {
            tracing::warn!("Recovery setup admission release failed: {error}");
            Ok(summary)
        }
    }
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
    use matrix_sdk::{
        ruma::{
            events::secret_storage::key::{
                SecretStorageEncryptionAlgorithm, SecretStorageKeyEventContent,
                SecretStorageV1AesHmacSha2Properties,
            },
            serde::Base64,
        },
        test_utils::mocks::MatrixMockServer,
    };
    use std::sync::Mutex;

    const ISSUED_KEY: &str = "EsTj 3yST y93F SLpB jJsz eAXc 2XzA ygD3 w69H fGaN TKBj jXEd";

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
            recovery_key: Some(ISSUED_KEY.into()),
            room_keys_backed_up: true,
            server_mutation_started: true,
        }
    }

    async fn client_with_current_recovery_key() -> (MatrixMockServer, Client) {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server
            .mock_get_default_secret_storage_key()
            .ok(client.user_id().unwrap(), "current")
            .mount()
            .await;
        server
            .mock_get_secret_storage_key()
            .ok(
                client.user_id().unwrap(),
                &SecretStorageKeyEventContent::new(
                    "current".into(),
                    SecretStorageEncryptionAlgorithm::V1AesHmacSha2(
                        SecretStorageV1AesHmacSha2Properties::new(
                            Some(Base64::parse("xv5b6/p3ExEw++wTyfSHEg==").unwrap()),
                            Some(
                                Base64::parse("ujBBbXahnTAMkmPUX2/0+VTfUh63pGyVRuBcDMgmJC8=")
                                    .unwrap(),
                            ),
                        ),
                    ),
                ),
            )
            .mount()
            .await;
        (server, client)
    }

    #[tokio::test]
    async fn issued_key_is_revalidated_and_only_matching_acknowledgement_removes_it() {
        let (_server, client) = client_with_current_recovery_key().await;
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
            ISSUED_KEY
        );
        assert!(acknowledge(&client, &custody, "other key".into())
            .await
            .is_err());
        assert!(custody.load().await.unwrap().is_some());
        acknowledge(&client, &custody, ISSUED_KEY.into())
            .await
            .unwrap();
        assert!(pending_summary(&client, &custody).await.unwrap().is_none());
        acknowledge(&client, &custody, ISSUED_KEY.into())
            .await
            .unwrap();
        assert!(custody.load().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn retry_rejects_a_different_passphrase_without_changing_custody() {
        let (_server, client) = client_with_current_recovery_key().await;
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
            ISSUED_KEY
        );
    }

    #[tokio::test]
    async fn failed_acknowledgement_preserves_the_pending_key() {
        let (_server, client) = client_with_current_recovery_key().await;
        let custody = MemoryCustody {
            pending: Mutex::new(Some(pending())),
            fail_save: true,
        };
        assert!(acknowledge(&client, &custody, ISSUED_KEY.into())
            .await
            .is_err());
        assert_eq!(
            pending_summary(&client, &custody)
                .await
                .unwrap()
                .unwrap()
                .recovery_key,
            ISSUED_KEY
        );
    }

    #[tokio::test]
    async fn replaced_secret_storage_rejects_the_cached_recovery_key() {
        let (_server, client) = client_with_current_recovery_key().await;
        let mut stale = pending();
        stale.recovery_key =
            Some("DsTj 3yST y93F SLpB jJsz eAXc 2XzA ygD3 w69H fGaN TKBj jXEd".into());
        let custody = MemoryCustody {
            pending: Mutex::new(Some(stale.clone())),
            fail_save: false,
        };

        assert!(issued_key_is_stale(&client, &stale).await.unwrap());
        assert!(pending_summary(&client, &custody).await.is_err());
        assert!(acknowledge(&client, &custody, ISSUED_KEY.into())
            .await
            .is_err());
        assert!(custody.load().await.unwrap().is_some());
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
