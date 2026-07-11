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

Every night (and on demand via the [Nightly platform builds](../../actions/workflows/nightly-platform-builds.yml)
workflow), CI builds macOS/Windows/Linux/Android and publishes them to a
date-tagged, pre-release [GitHub Release](../../releases) (`nightly-YYYY-MM-DD`,
overwritten if re-run same day). These are debug builds for testing — not
signed by a trusted publisher, not auto-updating, not for production use.
iOS is intentionally not published here: Apple requires a paid Developer
Program membership to install on a real device, so iOS nightlies stay a
CI-only compile check.

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
  apps), then open the file. The APK is signed with Android's auto-generated
  debug keystore, which is sufficient to install — no separate cert needed.

### Generating a nightly signing cert (maintainers)

macOS/Windows nightly builds are signed automatically once the following
repo secrets exist; until then, both platforms fall back to unsigned builds
(the workflow degrades gracefully either way).

**macOS** — Keychain Access → **Certificate Assistant → Create a
Certificate…** → Identity Type **Self-Signed Root**, Certificate Type
**Code Signing** (same flow as the local-dev cert in this repo's
`CLAUDE.md`, but exported instead of kept local). Then:

```sh
security export -k login.keychain-db -t identities -f pkcs12 -P "<a password>" -o cert.p12 \
  -c "<the cert's common name>"
base64 -i cert.p12 -o cert.p12.b64
```

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
