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
`ba98bfadc4c868c9a7e1a226c83af528e1f11b89` (PR3698). Updater endpoints, signing keys, API permissions and platform install behavior
are unchanged. The additional approved TLS hardening is described below.
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


## Charm TLS hardening

The owner approved removing optional TLS bypass behavior on October 27, 2026.
The public Rust configuration no longer exposes certificate/hostname bypass
fields. JSON still recognizes both upstream camelCase and kebab-case spellings,
accepts omitted/false values, and rejects true or malformed values explicitly.
This avoids silently accepting an unsafe legacy configuration.

The arbitrary `UpdaterBuilder::configure_client` API, callback type and stored
callback are removed. Such callbacks could replace the entire TLS backend, so
resetting two booleans after invoking them would not enforce the boundary.
Both metadata and download requests now retain reqwest's standard TLS validation.
Normal headers, proxy settings, timeouts and signature verification are unchanged.
Existing transport-protocol configuration is outside this scoped change.

Charm's tracked configuration uses none of the removed capabilities. This is an
intentional incompatibility for external users of those optional upstream APIs,
not a claim of a demonstrated active TLS vulnerability in shipped Charm builds.
The upstream migration/removal decision must preserve this boundary or explicitly
review its replacement. Hosted configuration tests cover both legacy spellings,
malformed values and ordinary/current configuration. Rustdoc compile-fail tests
cover the removed fields/callback, with a compile-pass control for supported
request customization. Existing extraction/signature tests and CodeQL remain
required; no findings are suppressed or dismissed.
