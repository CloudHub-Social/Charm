//! Real-network proof that `get_own_profile_impl` (the core behind Spec 01's
//! `get_own_profile` command) reports the signed-in user's own display
//! name/avatar and maps presence correctly. Single account, no mocking — see
//! `dev/synapse/README.md` for the local homeserver this needs.

mod common;

use charm_lib::matrix::presence::PresenceStateDto;
use charm_lib::matrix::profiles::get_own_profile_impl;
use common::synced_client;

#[tokio::test]
async fn reports_the_signed_in_users_own_display_name_and_avatar() {
    let client = synced_client().await;

    let display_name = format!("Spec01 Own Profile Test {}", std::process::id());
    client
        .account()
        .set_display_name(Some(&display_name))
        .await
        .expect("set display name");

    let avatar_bytes = format!("spec01-own-profile-avatar-{}", std::process::id()).into_bytes();
    let upload = client
        .media()
        .upload(&mime::IMAGE_PNG, avatar_bytes, None)
        .await
        .expect("upload avatar");
    client
        .account()
        .set_avatar_url(Some(&upload.content_uri))
        .await
        .expect("set avatar url");

    let profile = get_own_profile_impl(&client, None, PresenceStateDto::Unavailable)
        .await
        .expect("get_own_profile_impl succeeds");

    assert_eq!(
        profile.user_id,
        client.user_id().expect("logged in").to_string()
    );
    assert_eq!(profile.display_name.as_deref(), Some(display_name.as_str()));
    assert_eq!(
        profile.avatar_url.as_deref(),
        Some(upload.content_uri.as_str())
    );
    // No media cache passed in, so this should resolve to `None` rather than
    // panicking/erroring — same "no hard dependency on Spec 02" contract
    // `resolve_avatar_path`/`resolve_avatar_thumbnail` document.
    assert_eq!(profile.avatar_path, None);
    assert_eq!(profile.presence, PresenceStateDto::Unavailable);
}
