//! Explicit state authority. Never fall back to legacy Spaces when R2 is selected.
use std::{sync::Arc, time::Duration};
use object_store::{aws::AmazonS3Builder, ObjectStore, RetryConfig};

const PREFIX: &str = "CHARM_WEB_SERVER_STATE_";
const ACCOUNT: &str = "bb346e009981b1b928a5b8e008f7021d";
const BUCKET: &str = "charm-api-state-production";

// At most two transport attempts. Conditional headers and retryability remain
// owned by object_store; HTTP 412 is never retried as a transient failure.
fn retry_policy() -> RetryConfig {
    RetryConfig {
        max_retries: 1,
        retry_timeout: Duration::from_secs(5),
        ..Default::default()
    }
}

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
        .with_retry(retry_policy())
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, StatusCode};
    use object_store::{path::Path, ObjectStoreExt, PutMode, PutOptions, PutPayload, UpdateVersion};
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn transient_reads_retry_once_and_persistent_errors_stop() {
        for recover in [true, false] {
            let count = Arc::new(AtomicUsize::new(0));
            let requests = Arc::clone(&count);
            let router = axum::Router::new().route(
                "/fixture/object",
                axum::routing::get(move || {
                    let attempt = requests.fetch_add(1, Ordering::SeqCst);
                    async move {
                        if recover && attempt > 0 {
                            (StatusCode::OK, [("etag", "\"fixture\""), ("last-modified", "Wed, 21 Oct 2015 07:28:00 GMT")], "fixture")
                        } else {
                            (StatusCode::SERVICE_UNAVAILABLE, [("etag", "\"fixture\""), ("last-modified", "Wed, 21 Oct 2015 07:28:00 GMT")], "unavailable")
                        }
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let backend = fixture_store(listener.local_addr().unwrap());
            let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
            let result = backend.get(&Path::from("object")).await;
            server.abort();
            assert_eq!(result.is_ok(), recover);
            assert_eq!(count.load(Ordering::SeqCst), 2);
        }
    }

    #[tokio::test]
    async fn conditional_writes_preserve_conditions_and_do_not_retry_preconditions() {
        for create in [true, false] {
            for status in [StatusCode::PRECONDITION_FAILED, StatusCode::SERVICE_UNAVAILABLE] {
                let count = Arc::new(AtomicUsize::new(0));
                let requests = Arc::clone(&count);
                let router = axum::Router::new().route(
                    "/fixture/object",
                    axum::routing::put(move |headers: HeaderMap| {
                        requests.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(headers.get(if create { "if-none-match" } else { "if-match" }).unwrap(), if create { "*" } else { "\"fixture\"" });
                        async move { (status, "synthetic") }
                    }),
                );
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let backend = fixture_store(listener.local_addr().unwrap());
                let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
                let mode = if create { PutMode::Create } else { PutMode::Update(UpdateVersion { e_tag: Some("\"fixture\"".into()), version: None }) };
                let result = backend.put_opts(&Path::from("object"), PutPayload::from_static(b"fixture"), PutOptions { mode, ..Default::default() }).await;
                server.abort();
                assert!(result.is_err());
                assert_eq!(count.load(Ordering::SeqCst), if status == StatusCode::PRECONDITION_FAILED { 1 } else { 2 });
            }
        }
    }

    fn fixture_store(address: std::net::SocketAddr) -> impl ObjectStore {
        AmazonS3Builder::new()
            .with_bucket_name("fixture")
            .with_region("us-east-1")
            .with_endpoint(format!("http://{address}"))
            .with_access_key_id("fixture-access")
            .with_secret_access_key("fixture-secret")
            .with_allow_http(true)
            .with_retry(retry_policy())
            .build().unwrap()
    }
}
