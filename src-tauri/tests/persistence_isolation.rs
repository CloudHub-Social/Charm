//! Real network + real-filesystem proof of Spec 15 (per-account store
//! isolation): logging in as two distinct accounts against the same
//! `matrix_store/` root must not reproduce
//! "the account in the store doesn't match the account in the constructor" —
//! each account gets its own SQLCipher store directory and keychain
//! passphrase, keyed by `persistence::account_key`.
//!
//! These build `matrix_sdk::Client`s directly (like `discovery_and_registration.rs`)
//! against `persistence`'s pure, `AppHandle`-free helpers rather than going
//! through the `#[tauri::command]` entry points in `matrix::mod`, since those
//! require a real `tauri::AppHandle` that isn't available outside a running
//! app. This exercises exactly the same store-path/passphrase/relocate logic
//! `login`/`start_sso_login`/`complete_sso_login` call internally.

mod common;

use charm_lib::matrix::persistence;
use common::{test_password, test_password_2, test_username, test_username_2, HOMESERVER};
use matrix_sdk::config::SyncSettings;
use matrix_sdk::Client;

/// A scratch `matrix_store/`-equivalent root, cleaned up on drop, so this
/// test file's runs don't collide with each other or with a real dev store.
struct ScratchRoot(std::path::PathBuf);

impl ScratchRoot {
    fn new(name: &str) -> Self {
        let unique = format!("charm-persistence-isolation-{name}-{}", std::process::id());
        let path = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for ScratchRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn build_and_login(
    root: &std::path::Path,
    store_key: &str,
    username: &str,
    password: &str,
) -> Client {
    let store_path = persistence::store_path_at(root, store_key).expect("store dir");
    let passphrase = persistence::get_or_create_passphrase(store_key).expect("passphrase");

    let client = Client::builder()
        .homeserver_url(HOMESERVER)
        .sqlite_store(&store_path, Some(&passphrase))
        .build()
        .await
        .expect("build client against its own per-account/temp store");

    client
        .matrix_auth()
        .login_username(username, password)
        .send()
        .await
        .expect("login succeeds");

    client
}

/// The core regression test: two distinct accounts, logged in sequentially
/// against stores under the *same* root directory, must not collide —
/// reproducing the bug's absence, not its presence.
#[tokio::test]
async fn two_distinct_accounts_login_sequentially_without_crypto_mismatch() {
    let root = ScratchRoot::new("two-accounts");

    let key_a = persistence::account_key(&format!("@{}:localhost", test_username()));
    let key_b = persistence::account_key(&format!("@{}:localhost", test_username_2()));
    assert_ne!(key_a, key_b, "distinct accounts must derive distinct keys");

    let client_a = build_and_login(&root.0, &key_a, &test_username(), &test_password()).await;
    client_a
        .sync_once(SyncSettings::default())
        .await
        .expect("account A can sync against its own store");

    // The second login, against a *different* per-account store under the
    // same root, is exactly the scenario that reproduced
    // "the account in the store doesn't match the account in the
    // constructor" before per-account isolation.
    let client_b = build_and_login(&root.0, &key_b, &test_username_2(), &test_password_2()).await;
    client_b
        .sync_once(SyncSettings::default())
        .await
        .expect("account B can sync against its own store, unaffected by account A's");

    let session_a = client_a.matrix_auth().session().expect("account A session");
    let session_b = client_b.matrix_auth().session().expect("account B session");
    assert_ne!(session_a.meta.user_id, session_b.meta.user_id);

    // Each account's store lives in its own subdirectory.
    assert!(root.0.join(&key_a).is_dir());
    assert!(root.0.join(&key_b).is_dir());
}

/// `try_restore_session`'s per-account routing: after "restarting the app"
/// (dropping and rebuilding the client), each account restores against its
/// own store and only its own store.
#[tokio::test]
async fn each_account_restores_against_its_own_store() {
    let root = ScratchRoot::new("restore");

    let key_a = persistence::account_key(&format!("@{}:localhost", test_username()));
    let key_b = persistence::account_key(&format!("@{}:localhost", test_username_2()));

    let client_a = build_and_login(&root.0, &key_a, &test_username(), &test_password()).await;
    let session_a = client_a.matrix_auth().session().expect("account A session");
    drop(client_a);

    let client_b = build_and_login(&root.0, &key_b, &test_username_2(), &test_password_2()).await;
    let session_b = client_b.matrix_auth().session().expect("account B session");
    drop(client_b);

    // Simulate an app restart: rebuild clients against each account's own
    // store path and restore the saved session.
    let restored_a_path = persistence::store_path_at(&root.0, &key_a).expect("store dir");
    let restored_a = Client::builder()
        .homeserver_url(HOMESERVER)
        .sqlite_store(
            &restored_a_path,
            Some(&persistence::get_or_create_passphrase(&key_a).unwrap()),
        )
        .build()
        .await
        .expect("build client");
    restored_a
        .matrix_auth()
        .restore_session(
            session_a.clone(),
            matrix_sdk::store::RoomLoadSettings::default(),
        )
        .await
        .expect("account A restores against its own store");
    assert_eq!(
        restored_a.matrix_auth().session().unwrap().meta.user_id,
        session_a.meta.user_id
    );

    let restored_b_path = persistence::store_path_at(&root.0, &key_b).expect("store dir");
    let restored_b = Client::builder()
        .homeserver_url(HOMESERVER)
        .sqlite_store(
            &restored_b_path,
            Some(&persistence::get_or_create_passphrase(&key_b).unwrap()),
        )
        .build()
        .await
        .expect("build client");
    restored_b
        .matrix_auth()
        .restore_session(
            session_b.clone(),
            matrix_sdk::store::RoomLoadSettings::default(),
        )
        .await
        .expect("account B restores against its own store");
    assert_eq!(
        restored_b.matrix_auth().session().unwrap().meta.user_id,
        session_b.meta.user_id
    );
}

/// The SSO/QR shape: login against a temp store, then relocate it to the
/// real per-account path — a fresh client pointed at the relocated path
/// must be able to restore the session, proving the passphrase moved in
/// lockstep with the directory rename.
#[tokio::test]
async fn temp_store_relocates_and_restores_correctly() {
    let root = ScratchRoot::new("relocate");

    let temp_key = persistence::temp_store_key();
    let client = build_and_login(&root.0, &temp_key, &test_username(), &test_password()).await;
    let session = client.matrix_auth().session().expect("session");
    let account_key = persistence::account_key(session.meta.user_id.as_str());
    drop(client);

    let relocated_path =
        persistence::relocate_store_at(&root.0, &temp_key, &account_key).expect("relocate");
    assert_eq!(relocated_path, root.0.join(&account_key));
    assert!(!root.0.join(&temp_key).exists());

    let restored = Client::builder()
        .homeserver_url(HOMESERVER)
        .sqlite_store(
            &relocated_path,
            Some(&persistence::get_or_create_passphrase(&account_key).unwrap()),
        )
        .build()
        .await
        .expect("build client against relocated store");
    restored
        .matrix_auth()
        .restore_session(
            session.clone(),
            matrix_sdk::store::RoomLoadSettings::default(),
        )
        .await
        .expect("session restores against the relocated store");
}

/// A cancelled SSO/QR login (this test stands in for `cancel_sso_login`/
/// `cancel_qr_login`, which call the same `discard`-style cleanup this test
/// exercises directly) must leave no orphan temp store on disk.
#[test]
fn cancelled_login_leaves_no_orphan_temp_store() {
    let root = ScratchRoot::new("cancel");
    let temp_key = persistence::temp_store_key();

    let temp_path = persistence::store_path_at(&root.0, &temp_key).expect("store dir");
    let _ = persistence::get_or_create_passphrase(&temp_key).expect("passphrase");
    assert!(temp_path.exists());

    persistence::sweep_orphan_temp_stores_at(&root.0).expect("sweep");

    assert!(!temp_path.exists());
}
