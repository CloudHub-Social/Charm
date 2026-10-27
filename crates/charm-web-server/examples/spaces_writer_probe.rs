//! Isolated capability probe, never server startup. See the accompanying runbook.
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use object_store::aws::AmazonS3Builder;
use object_store::client::{
    HttpClient, HttpConnector, HttpError, HttpErrorKind, HttpRequest, HttpResponse, HttpService,
};
use object_store::path::Path;
use object_store::{ClientOptions, ObjectStore, ObjectStoreExt, PutMode, RetryConfig, UpdateVersion};

// Deliberate execution hold: HTTP accounting does not enforce provider wire egress.
const PROVIDER_EGRESS_CAP_VERIFIED: bool = false;
const BUCKET: &str = "charm-writer-probe-20261027";
const HOST: &str = "charm-writer-probe-20261027.tor1.digitaloceanspaces.com";
const KEY: &str = "synthetic-writer-conditional-probe";
const PLAIN: &str = "synthetic-owner-before";
const JSON: &str = r#"{"writer_id":"synthetic-owner-after","previous_writer_id":null,"activation_expires_at_ms":null,"mutation_owner":null,"mutation_expires_at_ms":null}"#;

#[derive(Debug, Default)]
struct Budget {
    requests: AtomicUsize,
    response_bytes: AtomicUsize,
}

#[derive(Debug, Clone)]
struct GuardedConnector(Arc<Budget>);

#[derive(Debug)]
struct GuardedService {
    client: HttpClient,
    budget: Arc<Budget>,
}

fn stopped() -> HttpError {
    HttpError::new(HttpErrorKind::Unknown, std::io::Error::other("probe guard stopped request"))
}

impl HttpConnector for GuardedConnector {
    fn connect(&self, _: &ClientOptions) -> object_store::Result<HttpClient> {
        // No redirects, proxies, automatic credentials, TLS exceptions or HTTP retries.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .http1_only()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| object_store::Error::Generic {
                store: "isolated-probe",
                source: "HTTP client construction failed".into(),
            })?;
        Ok(HttpClient::new(GuardedService {
            client: HttpClient::new(client),
            budget: Arc::clone(&self.0),
        }))
    }
}

// Spell out async_trait's signature to avoid adding a dependency just for this example.
impl HttpService for GuardedService {
    fn call<'a, 'f>(
        &'a self,
        request: HttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + 'f>>
    where
        'a: 'f,
        Self: 'f,
    {
        Box::pin(async move {
            let uri = request.uri();
            let method = request.method().as_str();
            if uri.scheme_str() != Some("https")
                || uri.host() != Some(HOST)
                || uri.port().is_some()
                || uri.path() != format!("/{KEY}")
                || uri.query().is_some()
                || !matches!(method, "GET" | "HEAD" | "PUT" | "DELETE")
            {
                return Err(stopped());
            }
            // Leave room for cleanup even when qualification stops early.
            let used = self.budget.requests.load(Ordering::SeqCst);
            let ceiling = if matches!(method, "DELETE" | "HEAD") { 20 } else { 16 };
            if used >= ceiling {
                return Err(stopped());
            }
            self.budget.requests.fetch_add(1, Ordering::SeqCst);
            let response = self.client.execute(request).await?;
            let (parts, body) = response.into_parts();
            let header_bytes: usize = parts.headers.iter().map(|(k, v)| k.as_str().len() + v.len() + 4).sum();
            let previous = self.budget.response_bytes.fetch_add(header_bytes + 64, Ordering::SeqCst);
            if previous + header_bytes + 64 > 65536 {
                return Err(stopped());
            }
            let mut bytes = Vec::new();
            let mut stream = body.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk?;
                let previous = self.budget.response_bytes.fetch_add(chunk.len(), Ordering::SeqCst);
                if previous + chunk.len() > 65536 || bytes.len() + chunk.len() > 2048 {
                    return Err(stopped());
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(HttpResponse::from_parts(parts, bytes.into()))
        })
    }
}

async fn qualify(store: &dyn ObjectStore, path: &Path) -> Result<(), &'static str> {
    let initial = store.put_opts(path, PLAIN.into(), PutMode::Create.into()).await
        .map_err(|_| "initial_create_failed")?;
    if initial.e_tag.is_none() { return Err("missing_create_etag"); }
    let read = store.get(path).await.map_err(|_| "initial_read_failed")?;
    let version = UpdateVersion { e_tag: read.meta.e_tag.clone(), version: read.meta.version.clone() };
    if version.e_tag.is_none() { return Err("missing_read_etag"); }
    if read.bytes().await.map_err(|_| "initial_body_failed")?.as_ref() != PLAIN.as_bytes() {
        return Err("initial_content_mismatch");
    }
    store.put_opts(path, JSON.into(), PutMode::Update(version.clone()).into()).await
        .map_err(|_| "current_etag_update_failed")?;
    match store.put_opts(path, PLAIN.into(), PutMode::Update(version).into()).await {
        Err(object_store::Error::Precondition { .. }) => {},
        _ => return Err("stale_etag_not_rejected_as_precondition"),
    }
    match store.put_opts(path, PLAIN.into(), PutMode::Create.into()).await {
        Err(object_store::Error::AlreadyExists { .. }) | Err(object_store::Error::Precondition { .. }) => {},
        _ => return Err("duplicate_create_not_rejected"),
    }
    let final_bytes = store.get(path).await.map_err(|_| "final_read_failed")?
        .bytes().await.map_err(|_| "final_body_failed")?;
    if final_bytes.as_ref() != JSON.as_bytes() { return Err("rejected_write_changed_content"); }
    Ok(())
}

#[tokio::main]
async fn main() {
    // Default is inert; CI compilation must never perform provider I/O.
    if std::env::args().nth(1).as_deref() != Some("--approved-live-probe") {
        println!("probe_not_executed");
        return;
    }
    if !PROVIDER_EGRESS_CAP_VERIFIED
        || std::env::var("CHARM_PROBE_APPROVED_BUCKET").as_deref() != Ok(BUCKET)
        || std::env::var("GITHUB_RUN_ATTEMPT").as_deref() != Ok("1")
        || std::env::var("CHARM_PROBE_APPROVED_SHA").ok() != std::env::var("GITHUB_SHA").ok()
        || std::env::var("GITHUB_SHA").map_or(true, |sha| sha.len() != 40)
    {
        eprintln!("probe_execution_guard_failed");
        std::process::exit(1);
    }
    let required = |name| std::env::var(name).expect("missing dedicated probe credential");
    let budget = Arc::new(Budget::default());
    let store = AmazonS3Builder::new()
        .with_bucket_name(BUCKET)
        .with_region("tor1")
        .with_endpoint(format!("https://{HOST}"))
        .with_virtual_hosted_style_request(true)
        .with_access_key_id(required("CHARM_PROBE_ACCESS_KEY_ID"))
        .with_secret_access_key(required("CHARM_PROBE_SECRET_ACCESS_KEY"))
        .with_retry(RetryConfig { max_retries: 0, ..Default::default() })
        .with_http_connector(GuardedConnector(Arc::clone(&budget)))
        .build().expect("probe client construction failed");
    let path = Path::from(KEY);
    // The control-plane operator must first attest this newly created bucket is empty.
    if !matches!(store.head(&path).await, Err(object_store::Error::NotFound { .. })) {
        eprintln!("fresh_empty_probe_target_not_verified");
        std::process::exit(1);
    }
    let result = qualify(&store, &path).await;
    // A failed PUT can have an uncertain outcome. Delete the sole allowed synthetic
    // key regardless of the qualification result, then verify its absence.
    let deleted = store.delete(&path).await.is_ok();
    let absent = matches!(store.head(&path).await, Err(object_store::Error::NotFound { .. }));
    println!("{}", serde_json::json!({
        "qualification": result.err().unwrap_or("passed"),
        "object_delete_accepted": deleted,
        "object_absence_verified": absent,
        "requests": budget.requests.load(Ordering::SeqCst),
        "observed_http_response_bytes": budget.response_bytes.load(Ordering::SeqCst),
        "provider_wire_egress_cap_verified": false,
    }));
    if result.is_err() || !deleted || !absent { std::process::exit(1); }
}
