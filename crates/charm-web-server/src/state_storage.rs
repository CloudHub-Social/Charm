//! Explicit state authority. Never fall back to legacy Spaces when R2 is selected.
use std::sync::Arc;
use object_store::{aws::AmazonS3Builder, ObjectStore, RetryConfig};

const PREFIX: &str = "CHARM_WEB_SERVER_STATE_";
const ACCOUNT: &str = "bb346e009981b1b928a5b8e008f7021d";
const BUCKET: &str = "charm-api-state-production";

pub fn configured() -> bool {
    std::env::vars_os().any(|(name, _)| name.to_string_lossy().starts_with(PREFIX))
}

fn required(name: &str) -> Result<String, String> {
    std::env::var(name).ok().filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("required state configuration missing: {name}"))
}

fn build(prefix: &str, r2: bool) -> Result<Arc<dyn ObjectStore>, String> {
    let bucket = required(&format!("{prefix}BUCKET"))?;
    let endpoint = required(&format!("{prefix}ENDPOINT"))?;
    let region = required(&format!("{prefix}REGION"))?;
    if r2 && (bucket != BUCKET || endpoint != format!("https://{ACCOUNT}.r2.cloudflarestorage.com") || region != "auto") {
        return Err("state destination differs from approved R2 scope".into());
    }
    let endpoint = if r2 { endpoint } else {
        let host = endpoint.strip_prefix("https://").ok_or("source endpoint must use HTTPS")?;
        if host != "tor1.digitaloceanspaces.com" { return Err("source endpoint differs from approved Spaces region".into()); }
        format!("https://{bucket}.{host}")
    };
    let store = AmazonS3Builder::new()
        .with_bucket_name(bucket).with_region(region).with_endpoint(endpoint)
        .with_access_key_id(required(&format!("{prefix}ACCESS_KEY_ID"))?)
        .with_secret_access_key(required(&format!("{prefix}SECRET_ACCESS_KEY"))?)
        .with_virtual_hosted_style_request(!r2)
        // Deliberate cutover budget bound, including reads: a transient failure
        // is surfaced to the caller, not amplified by hidden transport retries.
        // Existing application CAS retry limits remain unchanged. Increasing
        // this requires accounting for the resulting operation/latency budget.
        .with_retry(RetryConfig { max_retries: 0, ..Default::default() })
        .build().map_err(|_| "invalid state storage configuration")?;
    Ok(Arc::new(store))
}

pub fn destination() -> Result<Option<Arc<dyn ObjectStore>>, String> {
    if !configured() { return Ok(None); }
    build(PREFIX, true).map(Some)
}

/// Runs before listeners, sweepers, session restoration or writer activation.
/// The deployment controller must attest a stopped source at this exact revision.
pub async fn prepare() -> Result<(), String> {
    let Some(destination) = destination()? else { return Ok(()); };
    if crate::state_migration::completed(destination.as_ref()).await? { return Ok(()); }
    let source_sha = required("CHARM_WEB_SERVER_SOURCE_SHA")?;
    if required("CHARM_WEB_SERVER_STATE_CUTOVER_SHA")? != source_sha {
        return Err("state cutover is not approved for this exact source revision".into());
    }
    let sessions = build("CHARM_WEB_SERVER_SPACES_", false)?;
    let crypto = build("CHARM_WEB_SERVER_CRYPTO_SPACES_", false)?;
    if required("CHARM_WEB_SERVER_SPACES_BUCKET")? != "charm-web-server-sessions"
        || required("CHARM_WEB_SERVER_CRYPTO_SPACES_BUCKET")? != "charm-web-server-crypto" {
        return Err("state migration source differs from approved buckets".into());
    }
    crate::state_migration::migrate(sessions.as_ref(), crypto.as_ref(), destination.as_ref()).await
}
