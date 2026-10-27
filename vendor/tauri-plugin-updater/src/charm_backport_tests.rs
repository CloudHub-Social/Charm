// Charm-only backport qualification. Never calls install/ShellExecuteW.
use super::*;

#[test]
fn signature_accepts_public_fixture_and_rejects_modified_content() {
    // Public test vector from minisign-verify 0.2.4, src/lib.rs::tests::verify.
    // Its MIT license is retained in charm-fixtures/MINISIGN_FIXTURE_LICENSE.
    let key = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    let signature = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";
    let engine = base64::engine::general_purpose::STANDARD;
    let key = engine.encode(key);
    let signature = engine.encode(signature);
    assert!(verify_signature(b"test", &signature, &key).is_ok());
    assert!(verify_signature(b"Test", &signature, &key).is_err());
    assert!(verify_signature(b"test", &engine.encode("invalid signature"), &key).is_err());
    assert!(verify_signature(b"test", &signature, &engine.encode("invalid key")).is_err());
}

#[cfg(windows)]
fn update_fixture() -> Update {
    Update {
        body: None,
        current_version: "1.0.0".into(),
        version: "1.0.1".into(),
        date: None,
        target: "windows-x86_64".into(),
        download_url: "https://example.invalid/inert-fixture".parse().unwrap(),
        signature: String::new(),
        raw_json: serde_json::Value::Null,
        timeout: None,
        proxy: None,
        no_proxy: true,
        headers: HeaderMap::new(),
        extract_path: PathBuf::new(),
        context: UpdaterContext {
            config: Config::default(),
            configure_client: None,
            app_name: "charm-backport-test".into(),
            installer_args: Vec::new(),
            current_exe_args: vec!["Charm.exe".into()],
            on_before_exit: None,
            restart_after_install: true,
        },
    }
}

#[cfg(windows)]
#[test]
fn windows_installer_selection_preserves_stored_bytes_and_parameters() {
    for (bytes, is_msi) in [
        (include_bytes!("charm-fixtures/exe.zip").as_slice(), false),
        (include_bytes!("charm-fixtures/msi.zip").as_slice(), true),
        (
            include_bytes!("charm-fixtures/nested.zip").as_slice(),
            false,
        ),
    ] {
        let update = update_fixture();
        let installer = update.extract_zip(bytes).unwrap();
        let path = match &installer {
            WindowsUpdaterType::Nsis { path, .. } => {
                assert!(!is_msi);
                path.clone()
            }
            WindowsUpdaterType::Msi { path, .. } => {
                assert!(is_msi);
                PathBuf::from(path.to_string_lossy().trim_matches('"'))
            }
        };
        assert_eq!(std::fs::read(&path).unwrap(), b"inert installer fixture");
        let parameters = update
            .updater_parameters(&installer)
            .to_string_lossy()
            .into_owned();
        assert!(parameters.contains(if is_msi { "/i" } else { "/UPDATE" }));
        if path.parent().unwrap().join("nested").exists() {
            assert_eq!(
                std::fs::read(path.parent().unwrap().join("nested/hello.txt")).unwrap(),
                b"preserved nested content"
            );
        }
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}

#[cfg(windows)]
#[test]
fn windows_rejects_missing_installer_corruption_and_parent_escape() {
    let update = update_fixture();
    let outside = std::env::temp_dir().join("charm-zip-outside-sentinel.txt");
    std::fs::write(&outside, b"untouched sentinel").unwrap();
    assert!(update
        .extract_zip(include_bytes!("charm-fixtures/parent.zip"))
        .is_err());
    assert_eq!(std::fs::read(&outside).unwrap(), b"untouched sentinel");
    std::fs::remove_file(outside).unwrap();
    assert!(matches!(
        update.extract_zip(include_bytes!("charm-fixtures/no-installer.zip")),
        Err(Error::BinaryNotFoundInArchive)
    ));
    assert!(update.extract_zip(b"PK\x03\x04truncated").is_err());
}

#[cfg(unix)]
#[test]
fn zip_security_boundary_strips_privileged_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(include_bytes!(
        "charm-fixtures/privileged-mode.zip"
    )))
    .unwrap();
    // ZIP9 sanitizes unix_mode() itself. Inspect the immutable central-directory
    // external attributes to prove that the fixture really contains unsafe bits.
    let bytes = include_bytes!("charm-fixtures/privileged-mode.zip");
    let central = bytes.windows(4).position(|v| v == b"PK\x01\x02").unwrap();
    let attributes = u32::from_le_bytes(bytes[central + 38..central + 42].try_into().unwrap());
    assert_eq!((attributes >> 16) & 0o7000, 0o7000);
    archive.extract(root.path()).unwrap();
    assert_eq!(
        std::fs::metadata(root.path().join("payload"))
            .unwrap()
            .permissions()
            .mode()
            & 0o7000,
        0
    );
    assert_eq!(
        std::fs::read(root.path().join("payload")).unwrap(),
        b"ordinary content"
    );
}

#[cfg(unix)]
#[test]
fn zip_security_boundary_confines_symlinks_and_permission_changes() {
    use std::os::unix::fs::PermissionsExt;
    for bytes in [
        include_bytes!("charm-fixtures/symlink.zip").as_slice(),
        include_bytes!("charm-fixtures/symlink-mode.zip").as_slice(),
    ] {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("extract");
        std::fs::create_dir(&destination).unwrap();
        let outside = root.path().join("outside.txt");
        std::fs::write(&outside, b"untouched sentinel").unwrap();
        std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o640)).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        assert_eq!(
            archive.by_index(0).unwrap().unix_mode().unwrap() & 0o170000,
            0o120000
        );
        assert!(archive.extract(&destination).is_err());
        assert_eq!(std::fs::read(&outside).unwrap(), b"untouched sentinel");
        assert_eq!(
            std::fs::metadata(&outside).unwrap().permissions().mode() & 0o7777,
            0o640
        );
        assert!(!destination.join("link").exists());
    }
}
