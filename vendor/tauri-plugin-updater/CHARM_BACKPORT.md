# Temporary Charm updater backport

Source: published `tauri-plugin-updater` 2.11.0, upstream commit
`6aa2854f314481a459be1189b02c65a2450789ab`, `plugins/updater` in
<https://github.com/tauri-apps/plugins-workspace>.

Downloaded October 27, 2026 from
<https://static.crates.io/crates/tauri-plugin-updater/tauri-plugin-updater-2.11.0.crate>.
Archive SHA256: `b28d8cabdeb0564f03ae261963de4bc3d98321cd3d213e76a81b7d344e5df606`,
matching Charm's pre-patch registry lock entry. Apache-2.0 OR MIT; original
licenses, copyright notices, generated permissions and bundled API are retained.
Cargo's normalized manifest is used. The package's redundant lockfile, original
workspace-relative manifest, changelog and reporting document are not vendored.

Production delta: Windows `zip` dependency 4 -> 9, preserving optional/default
feature settings, following upstream commit
`ba98bfadc4c868c9a7e1a226c83af528e1f11b89` (PR3698). No updater control flow,
endpoints, signing keys, API permissions or platform install behavior is changed.
Windows `Error::Extract` consequently contains ZIP9's error type. Test-only
fixtures qualify extraction and signature behavior without invoking installers.

This is not a general fork. Charm maintains this one crate until a released
updater with ZIP9 can be adopted with equivalent platform/security evidence.
Remove the root path patch and this directory together after that migration;
retain these provenance and qualification receipts in the reviewing PR.
Never suppress the three ZIP advisories or reintroduce ZIP4 to resolve a build.

Hosted lockfile preparation run40433190847 selected ZIP9.1.2. Its only added
package is typed-path0.13.0; the existing Tauri/framework pins are unchanged.
Other ZIP dependencies reuse already-locked packages. The normal audit still
reports unrelated baseline advisories until integration with PR590/592.
The application notice generator explicitly includes this local crate so path
dependencies do not lose attribution. Only the byte-preserved generated JS is
excluded from application lint; Rust formatting/tests still apply.

ZIP9.1.2 declares Rust1.88, so this backport's manifest records that minimum
instead of the original updater's1.77.2. Charm already builds with newer Rust
(including the Rust1.96 companion image). No toolchain or production resources
change. The companion Docker build copies this workspace member explicitly.

The eight stored ZIP fixtures are authored test data (120–283 bytes), each with
only inert text payloads. An independent read-only metadata/content inspection
confirmed their contents before registering their exact SHA256 values in the
existing licensing gate. No extraction or local runtime verification was used.
The fixtures cover top-level EXE/MSI selection, nested text preservation, absent
installer, parent traversal, privileged Unix bits and escaping symlink targets.
No executable installer or third-party source is hidden in these archives.

The first hosted Unix pass showed that ZIP9 sanitizes unix_mode() before
extraction. The permission fixture's raw central-directory attributes are
therefore asserted directly, while the extracted mode and bytes retain their
original safety/compatibility assertions. This corrects the test's observation
point; it does not lower the required permission boundary.
