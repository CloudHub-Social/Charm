---
title: CI / release tiers
description: How Charm splits CI into fast PR gating, nightly platform builds, and releases.
---

:::note
This is the canonical release-tier guide. Additional CI cost and caching
background is retained in [`docs/ci-tiers.md`](https://github.com/CloudHub-Social/Charm/blob/main/docs/ci-tiers.md).
:::

Charm 2.0's CI is split into tiers, each with a different job: fast feedback
on every commit vs. thorough platform coverage vs. actually shipping a
release. The full native platform matrix (macOS, Windows, Linux, iOS,
Android) is by far the most expensive part of CI, so it doesn't run on every
PR push.

## Tier 1 — PR gate

Runs on every push to an open PR. **Blocking** — lint/format/typecheck/unit
tests, Rust fmt/clippy/nextest, Storybook + axe a11y, Playwright e2e,
CodeQL, dependency audits. No native platform bundling. A path-based
`changes` job skips whole categories when nothing relevant changed.

## Tier 2 — Merge queue

Same checks as Tier 1, re-run against the synthetic tree GitHub's merge
queue builds. Last gate before a commit lands on `main`.

## Tier 3 — Nightly platform builds

Full native builds — macOS, Windows, Linux, iOS (simulator), Android — on a
daily cron plus manual dispatch, off the current tip of `main`.
**Non-blocking**: a failure opens/comments on a tracking GitHub issue rather
than gating anyone's work. Builds in release profile so the published
nightly and Sentry symbolication both reflect what actually ships.

## Tier 4 — Production release _(signing-dependent)_

The release-PR workflow checks out the exact merge commit, creates a draft with
GitHub-generated release notes, and only then pushes the version tag. Knope
continues to prepare versions and the changelog in the release PR. The artifact
publisher requires a draft and never uses destructive asset replacement.
Interrupted uploads may resume only when existing files have identical SHA-256
digests. Different or unverifiable draft assets require explicit operator repair;
a published release requires a new version rather than replacement files.
Before publishing, the workflow verifies the complete remote asset count and
GitHub-reported SHA-256 digests against its locally signed artifact set. Upload
failure leaves an unpublished draft. Publication is serialized per version tag.
These workflow paths still require CI and a real release rehearsal; configuration
alone does not prove successful publication or recovery.

Triggered by pushing a version tag (`v*`). Debug-symbol/release-artifact
upload to Sentry is wired up. Linux, macOS, Windows, and Android jobs publish
their distributable bundles plus platform-named SPDX JSON SBOMs to the matching
GitHub release. The Linux job explicitly builds DEB/RPM bundles from the release revision
within a bounded build step; it cannot substitute nightly packages or debug-only
output. A recurrence of the historical Linux bundler hang blocks publication.
The publication job requires the complete artifact/SBOM set, includes every file
in `SHA256SUMS.txt`, and signs that manifest with the
repository release key. Platform-native production signing and Apple
notarization remain gated on their provider credentials; an iOS simulator build
is verification evidence, not a distributable release asset.

Tagged macOS builds must pass signature integrity, Gatekeeper assessment, and
stapled-ticket validation for the app and final disk images before uploading
release artifacts. Missing or untrusted signatures fail the job and therefore
block the dependent publication job; GPG checksums do not replace these platform
checks. The production certificate import and notarization submission setup is
still outstanding, so this gate intentionally prevents stable publication until
that setup and real signed-artifact validation are complete. Untagged diagnostic
dispatches and explicitly non-production nightlies retain their existing policy.
These checks follow Apple's [code-signing verification guidance](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html)
and [notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).

Tagged Android builds require `ANDROID_KEYSTORE_JKS`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`.
The workflow imports that existing identity, supplies Gradle's release signing
configuration, verifies APK signatures and their SHA-256 signer fingerprint,
and strictly verifies AAB signatures against the configured keystore alias.
These checks use Android's [apksigner](https://developer.android.com/tools/apksigner)
and Java's [jarsigner](https://docs.oracle.com/en/java/javase/18/docs/specs/man/jarsigner.html).

Tagged Windows builds require `WINDOWS_CERT_PFX` and `WINDOWS_CERT_PASSWORD`.
The imported identity is passed to Tauri's Authenticode configuration. The app
and installers must have valid signatures from that same identity before upload.
An untrusted self-signed certificate does not satisfy this stable-release gate;
signing alone does not establish SmartScreen reputation. Android key files and
the imported Windows private-key identity are removed in always-run cleanup
steps. Missing credentials or failed signature verification blocks publication.
No new signing identities are generated. Actual signed platform builds remain
required evidence; PR workflow checks alone do not establish signing readiness.
The manual `verify_platform_signing` input builds and verifies only Android and
Windows with these same gates, and is restricted to reviewed `main`. Other refs
fail the prerequisite policy job before signing jobs start. It uploads CI
artifacts but cannot publish a GitHub release. Run it after merging the workflow
to validate signing before a release cut without creating a version tag.
Manifest signing supports unencrypted GPG keys; protected keys require their
matching `GPG_PASSPHRASE`, and signing failures block publication.

Nightly publication uses the same four SBOM names. Because the SBOMs are present
before checksum and detached-signature generation, they are covered by the same
integrity chain and retained alongside the binaries. SBOM generation scans a
clean `git archive HEAD` export of the build commit in a fresh temporary
directory, excluding post-build generated files, dependency caches, Git
credentials, and runtime signing material. This source inventory does not
establish complete coverage of packaged binaries or platform-resolved transitive
dependencies. Artifact-level dependency completeness remains a separate
release-readiness gate.

For the full rationale and supporting-infrastructure details (rust-cache,
sccache, the Moonrepo backlog item), see
[`docs/ci-tiers.md`](https://github.com/CloudHub-Social/Charm/blob/main/docs/ci-tiers.md)
in the repository.

## Related documentation

- [Cloudflare previews](/operations/cloudflare-previews/) explains the
  per-pull-request web deployment and smoke check.
- [Sentry observability](/operations/sentry/) covers release artifacts,
  symbols, and the full visual snapshot suite.
- [Maintaining the feature gallery](/features/maintaining/) documents the
  curated E2E evidence generated from those checks.
- [Documentation workflow](../documentation/) defines when a code change must
  update specs, runbooks, or feature evidence in the same pull request.
