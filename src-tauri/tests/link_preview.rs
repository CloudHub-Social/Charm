//! Spec 29 live-homeserver evidence for the desktop transport.
//!
//! The test logs into the local Synapse instance and asks Synapse to fetch the
//! deterministic OpenGraph page served by `preview-target` in the same Docker
//! network. This is a real authenticated Matrix `/preview_url` round trip, not
//! the mocked homeserver coverage in `matrix::link_preview`'s unit tests.

mod common;

use charm_lib::matrix::link_preview::get_url_preview_impl;

const PREVIEW_TARGET_URL: &str = "http://preview-target/";

#[tokio::test]
async fn authenticated_desktop_preview_round_trips_through_synapse() {
    let client = common::logged_in_client().await;
    let preview = get_url_preview_impl(&client, PREVIEW_TARGET_URL.to_owned(), None)
        .await
        .expect("local Synapse should return the deterministic preview");

    assert_eq!(
        preview.title.as_deref(),
        Some("Charm link preview integration target")
    );
    assert_eq!(
        preview.description.as_deref(),
        Some("Deterministic OpenGraph data served only inside the local Synapse test network.")
    );
    assert_eq!(preview.site_name.as_deref(), Some("Charm test harness"));

    let missing = get_url_preview_impl(&client, format!("{PREVIEW_TARGET_URL}missing"), None).await;
    assert_eq!(
        missing, None,
        "a real homeserver target failure must degrade to no preview"
    );
}
