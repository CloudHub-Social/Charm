# Charm

Charm 2.0 — a ground-up rewrite of the Charm Matrix client (matrix-rust-sdk over typed
Tauri IPC, new design language). This is the active `charm` project going forward.

> Charm 1.0 (the matrix-js-sdk client) now lives at `~/git/Charm-1.0`
> (GitHub: `CloudHub-Social/Charm-1.0`).

Charm 2.0 is under active pre-release development — expect breaking changes and
missing features.

## Getting started

```sh
pnpm install
pnpm tauri dev    # native desktop app
# or
pnpm dev          # frontend only, in a browser (no Tauri IPC)
```

Run `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage`, and `pnpm build` before
opening a PR — see [CONTRIBUTING.md](CONTRIBUTING.md) for the full quality gate
and contribution guidelines.

## Installing a nightly build

Every night (and on demand via the [Nightly builds](../../actions/workflows/nightly.yml)
workflow), CI builds macOS/Windows/Linux/Android and publishes them to a
date-tagged, pre-release [GitHub Release](../../releases) (`nightly-YYYY-MM-DD`,
overwritten if re-run same day). These are release-profile builds for
testing — not signed by a trusted publisher, not auto-updating, not for
production use. iOS is intentionally not published here: Apple requires a
paid Developer Program membership to install on a real device, so iOS
nightlies stay a CI-only compile check.

Because the builds aren't signed by a certificate a trusted authority
recognizes, each OS's normal "this isn't from a known publisher" gate needs
a one-time bypass per download:

- **macOS**: the `.dmg`/`.app` may be signed with our self-signed cert (if
  configured — see below) or fully unsigned. Either way, macOS still blocks
  first launch as "from an unidentified developer." Right-click (or
  Control-click) the app → **Open** → **Open** in the confirmation dialog.
  A plain double-click will just refuse to launch.
- **Windows**: launching the installer trips SmartScreen's "Windows
  protected your PC." Click **More info**, then **Run anyway**. This
  warning is reputation-based and persists even with our self-signed cert —
  only a paid EV/OV certificate with an established reputation removes it.
- **Linux**: install the `.deb`/`.rpm` normally (`dpkg -i` / `rpm -i` or
  your distro's package manager) — no publisher-trust gate to bypass.
- **Android**: enable "Install unknown apps" for whatever app you used to
  download the `.apk` (Settings → Apps → Special access → Install unknown
  apps), then open the file. Signed with our persistent nightly keystore
  when configured (see below), which is what lets each night's APK install
  as an *update* over the previous one instead of requiring an uninstall
  first — Android refuses to install over an app it can't verify was signed
  by the same key. Without that keystore configured, it falls back to the
  Android Gradle Plugin's own auto-generated debug keystore, which is
  regenerated fresh on every CI run — every "nightly" would need a manual
  uninstall+reinstall in that case.

### Verifying a nightly download

Every asset attached to a nightly release (`.dmg`, `.msi`/`.exe`, `.deb`,
`.rpm`, `.apk`) can be checked two independent ways, both optional — neither
is enforced at install time the way the per-OS gates above are:

**Checksums** — `SHA256SUMS.txt` and `SHA1SUMS.txt` are attached to every
release, one line per artifact in standard `sha256sum`/`sha1sum` output
format. From the directory you downloaded into:

```sh
sha256sum -c SHA256SUMS.txt --ignore-missing   # Linux
shasum -a 256 -c SHA256SUMS.txt --ignore-missing   # macOS
```

(`--ignore-missing` skips lines for platforms you didn't download; drop it
if you grabbed everything.) SHA1 is provided because it was asked for, not
because it adds any real security over SHA256 — SHA1 is broken for
collision resistance. Treat `SHA256SUMS.txt` and the GPG signatures below as
the actual integrity checks, and `SHA1SUMS.txt` as compatibility-only.

**GPG signatures** — attached when the `GPG_PRIVATE_KEY` repo secret is
configured (see below): every artifact gets its own detached
`<filename>.asc`, and `SHA256SUMS.txt`/`SHA1SUMS.txt` are signed too (so
verifying `SHA256SUMS.txt.asc` alone vouches for every artifact's hash,
without checking each `.asc` individually — either approach works). The
public key ships alongside every signed release as
`charm-nightly-signing-key.asc`:

```sh
gpg --import charm-nightly-signing-key.asc
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
# or, for one specific artifact:
gpg --verify Charm_<version>_amd64.deb.asc Charm_<version>_amd64.deb
```

This is a self-issued key, not backed by a CA or Apple/Microsoft's
notarization chains — it proves the file matches what this pipeline
produced, not that "this pipeline" is an identity you already trust from
anywhere else. Compare `gpg`'s reported key fingerprint against the one
recorded when the key was generated (ask a maintainer) if you want that
assurance too.

### Generating a nightly signing cert (maintainers)

macOS/Windows/Android nightly builds are signed automatically once the
relevant repo secrets exist; until then, each platform falls back to its
previous unsigned/ephemeral-keystore behavior (the workflow degrades
gracefully either way). All platforms' artifacts are GPG-signed the same
way (centrally, once every artifact has been built — see
nightly.yml's publish-nightly job), purely for download
provenance — none of the OS-level publisher-trust gates above are affected
by it, only whether a `.asc` signature is available to verify against.

**macOS** — Keychain Access → **Certificate Assistant → Create a
Certificate…** → Identity Type **Self-Signed Root**, Certificate Type
**Code Signing** (same flow as the local-dev cert in this repo's
`CLAUDE.md`, but exported instead of kept local). Then:

```sh
security export -k login.keychain-db -t identities -f pkcs12 -P "<a password>" -o cert.p12 \
  -c "<the cert's common name>"
base64 -i cert.p12 -o cert.p12.b64
```

If you script this with `openssl pkcs12 -export` instead of `security export` (e.g. to
generate a cert without ever touching a local Keychain), add `-legacy`. OpenSSL 3.x's
default PKCS12 encryption (AES-256/SHA-256) fails to import into macOS's Keychain with a
misleading `MAC verification failed (wrong password?)` error even when the password is
correct — confirmed the hard way in production. `-legacy` switches to the RC2/3DES +
SHA-1 encryption `security import` actually understands.

Add as repo secrets: `MACOS_CERT_P12` (contents of `cert.p12.b64`),
`MACOS_CERT_PASSWORD` (the password used above), `MACOS_CERT_NAME` (the
cert's common name, exactly as it appears in Keychain Access).

**Windows** — from PowerShell:

```powershell
$cert = New-SelfSignedCertificate -Type CodeSigning -Subject "CN=Charm Nightly" `
  -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(5)
$password = ConvertTo-SecureString -String "<a password>" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath cert.pfx -Password $password
[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx")) | Out-File cert.pfx.b64
```

Add as repo secrets: `WINDOWS_CERT_PFX` (contents of `cert.pfx.b64`),
`WINDOWS_CERT_PASSWORD` (the password used above).

Neither cert needs to be trusted by anyone else's machine ahead of time —
they only remove the "unidentified publisher" badge, not the OS's
first-run friction described above.

**Android** — a normal Java keystore via `keytool` (bundled with any JDK).
Unlike the macOS/Windows certs, this one's identity *must* stay stable
release over release — regenerating it later breaks in-place updates for
anyone who already installed a nightly, the same way losing it would:

```sh
keytool -genkeypair -v -keystore charm-nightly.keystore -alias charm-nightly \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "<a password>" -keypass "<a password>" \
  -dname "CN=Charm Nightly, O=CloudHub Social"
base64 -i charm-nightly.keystore -o charm-nightly.keystore.b64   # macOS
# base64 -w0 charm-nightly.keystore > charm-nightly.keystore.b64  # Linux
```

Add as repo secrets: `ANDROID_KEYSTORE_JKS` (contents of
`charm-nightly.keystore.b64`), `ANDROID_KEYSTORE_PASSWORD` and
`ANDROID_KEY_PASSWORD` (the password used above — keytool above sets both
to the same value, but they can differ), `ANDROID_KEY_ALIAS` (`charm-nightly`
above). **Back up `charm-nightly.keystore` and its passwords somewhere
durable (e.g. Bitwarden) before deleting the local copy** — there's no
recovery path if it's lost, only starting over with a new identity that
breaks upgrades for existing installs.

**Linux (GPG)** — any GPG keypair; a passphrase-protected one since it's
going into repo secrets either way:

```sh
gpg --batch --full-generate-key <<'EOF'
%no-protection
Key-Type: RSA
Key-Length: 4096
Name-Real: Charm Nightly
Name-Email: nightly@cloudhub.social
Expire-Date: 2y
EOF
```

(Use a real passphrase-protected key instead of `%no-protection` if you'd
rather not rely on repo-secret confidentiality alone — swap in `Passphrase:
<a password>` and drop `%no-protection`.) Then export both halves:

```sh
key_id=$(gpg --list-secret-keys --with-colons | awk -F: '/^sec/ { print $5; exit }')
gpg --export-secret-keys --armor "$key_id" > charm-nightly-gpg-private.asc
```

Add as repo secrets: `GPG_PRIVATE_KEY` (contents of
`charm-nightly-gpg-private.asc`), `GPG_PASSPHRASE` (empty string is fine if
you used `%no-protection` above). The public key is re-exported and
published as a release asset (`charm-nightly-signing-key.asc`) by the
workflow itself on every signed run, so there's nothing else to distribute
by hand.

### sccache remote cache credentials

The nightly workflow's Rust builds are cached in a shared DigitalOcean Spaces
(S3-compatible) bucket via `sccache`. `SCCACHE_S3_ACCESS_KEY_ID` /
`SCCACHE_S3_SECRET_ACCESS_KEY` are a read-write key, used only on `main`
(scheduled runs and `main`-branch dispatches) to populate the cache.

`SCCACHE_S3_READONLY_ACCESS_KEY_ID` / `SCCACHE_S3_READONLY_SECRET_ACCESS_KEY`
are an optional read-only key pair (create one scoped to read-only access on
the same Space) used for `workflow_dispatch` runs against any other branch,
so those still get cache hits without holding write credentials — this pair
is deliberately never used as a fallback on `main` itself, even if the
write-capable pair above is somehow missing, since sccache's own S3 startup
check requires write access and would otherwise fail with a confusing
permissions error instead of a clean "no cache configured". Every job also
sets `SCCACHE_S3_RW_MODE=READ_ONLY` whenever it's using this key pair (it
defaults to `READ_WRITE` regardless of which credentials are handed to it) —
without that, a cache miss on a read-only key still attempts a write and
gets `AccessDenied` instead of just skipping it. Neither secret
of a pair configured is fine too — every job falls back to a local-disk-only
cache (by leaving `RUSTC_WRAPPER` unset, so sccache is never invoked at all)
instead of hard-failing, rather than pointing sccache at the bucket with no
credentials (which used to abort the build with an S3 "InvalidArgument"
error).

## Identity — keep it clean

This app publishes as plain **Charm**. Do **not** reintroduce a version suffix into any
published-facing identifier:

- `package.json` `name`: `charm`
- Tauri `productName`: `Charm`, `identifier`: `social.cloudhub.charm`
- deep-link scheme: `charm://`
- Cargo crate: `charm` / `charm_lib`

No `charm2`, `charm-2.0`, `Charm 2`, or `social.cloudhub.charm2` anywhere user- or
store-visible.

## Updater signing key

The real minisign keypair has been generated (`pnpm tauri signer generate -w
~/.tauri/charm-updater.key`) and the public half is in
`src-tauri/tauri.conf.json`'s `plugins.updater.pubkey`. The private key stays local,
password-protected, never committed. Still TODO before shipping updates for real:
add `endpoints` once a release/update server exists.

## Planning / source of truth

Scope, architecture, and design decisions live in the vault:
`Knowledge-Platform/10-19 Personal Life/15 Personal projects/15.12 Charm 2.0.md`.
