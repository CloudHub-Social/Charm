//! Fail closed before startup effects when provider source differs from the
//! revision selected by the protected release workflow. This does not make
//! older binaries without this guard safe rollback targets.

use std::ffi::OsStr;

const EXPECTED: &str = "CHARM_WEB_SERVER_EXPECTED_SOURCE_SHA";
const ACTUAL: &str = "CHARM_WEB_SERVER_SOURCE_SHA";

pub fn check_environment() -> Result<(), &'static str> {
    let expected = std::env::var_os(EXPECTED);
    let actual = std::env::var_os(ACTUAL);
    let durable = std::env::var_os("CHARM_WEB_SERVER_SPACES_BUCKET").is_some()
        || crypto_bucket_configured(std::env::var_os(crate::crypto_backup::BUCKET_ENV).as_deref());
    validate(expected.as_deref(), actual.as_deref(), durable)
}

// CryptoBackupStore disables backup for a blank bucket. Keep the session
// bucket's separate presence-based semantics, and reject non-Unicode crypto
// configuration conservatively rather than treating malformed input as absent.
fn crypto_bucket_configured(value: Option<&OsStr>) -> bool {
    match value {
        None => false,
        Some(value) => value.to_str().is_none_or(|value| !value.trim().is_empty()),
    }
}

fn validate(
    expected: Option<&OsStr>,
    actual: Option<&OsStr>,
    durable: bool,
) -> Result<(), &'static str> {
    if !durable && expected.is_none() && actual.is_none() {
        return Ok(());
    }
    let expected = sha(expected).ok_or("missing or invalid qualified source revision")?;
    let actual = sha(actual).ok_or("missing or invalid provider source revision")?;
    if expected != actual {
        return Err("provider source revision differs from qualified revision; startup refused");
    }
    Ok(())
}

fn sha(value: Option<&OsStr>) -> Option<&str> {
    value.and_then(OsStr::to_str).filter(|value| {
        value.len() == 40
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "066d06c6da2e663f771b2a97eed1a01284422687";

    #[test]
    fn development_without_spaces_needs_no_provider_metadata() {
        assert_eq!(validate(None, None, false), Ok(()));
    }

    #[test]
    fn blank_crypto_bucket_does_not_enable_release_requirements() {
        for bucket in [None, Some(OsStr::new("")), Some(OsStr::new(" \t\n"))] {
            assert_eq!(validate(None, None, crypto_bucket_configured(bucket)), Ok(()));
        }
        assert!(validate(None, None, crypto_bucket_configured(Some(OsStr::new("bucket")))).is_err());
        assert!(validate(None, None, crypto_bucket_configured(Some(OsStr::new(" bucket ")))).is_err());
    }

    #[test]
    fn durable_startup_requires_both_matching_revisions() {
        let sha = Some(OsStr::new(SHA));
        assert_eq!(validate(sha, sha, true), Ok(()));
        assert!(validate(None, None, true).is_err());
        assert!(validate(sha, None, true).is_err());
        assert!(validate(None, sha, true).is_err());
        assert!(validate(sha, Some(OsStr::new(&"a".repeat(40))), true).is_err());
    }

    #[test]
    fn supplied_metadata_is_never_ignored() {
        for invalid in ["", "main", "${_self.COMMIT_HASH}", "066d06c", "GGGG", "  "] {
            assert!(validate(Some(OsStr::new(invalid)), Some(OsStr::new(SHA)), false).is_err());
            assert!(validate(Some(OsStr::new(SHA)), Some(OsStr::new(invalid)), false).is_err());
        }
        assert!(validate(Some(OsStr::new(SHA)), None, false).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn non_unicode_metadata_fails_closed() {
        use std::os::unix::ffi::OsStrExt;
        assert!(crypto_bucket_configured(Some(OsStr::from_bytes(&[0xff]))));
        assert!(validate(Some(OsStr::from_bytes(&[0xff])), Some(OsStr::new(SHA)), true).is_err());
    }
}
