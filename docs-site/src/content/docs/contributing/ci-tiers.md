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
CodeQL and dependency audits. The separate iOS release-evidence lane retains
native simulator and archive proof. A tested changed-input selector skips
whole categories only when their inputs are known to be unaffected.

Changes to the companion API container inputs also build its actual Dockerfile
on a Linux runner. The Rust required gate includes this result, so the deployment
builder's compiler and system packages are verified before merge. This check
does not publish the image, start the server or access production credentials.
The builder is pinned to Rust 1.96 to meet matrix-sdk 0.19's minimum version.

The separate iOS release-evidence gate builds a release simulator app, checks
launch and deep-link handling, then shuts down its selected simulator before
creating an unsigned arm64 archive on the same runner. Failed smoke tests retain
simulator logs before shutdown; a shutdown failure also fails the gate. Native
build logs include compiler progress and bounded CPU,
memory, swap and disk samples. Resource artifact upload is best effort; the
archive, smoke test and required gate still fail normally on errors or timeout.

Cargo workspace output under root `target/` is ignored so Tailwind does not
scan generated Rust build files. The iOS lane plants a utility-class probe in
that directory and verifies it never appears in CSS, then compares CSS hashes
between the simulator and device builds. Generated native output must not alter
the frontend. These checks reuse the existing builds and do not add an archive.

### Qualification ownership and artifact reuse

`Quality checks` owns PR Storybook and browser execution. These required jobs
also capture screenshots; `Sentry Snapshots` is called only after both producers
succeed and consumes their same-run artifacts. It verifies repository, revision,
run ID, attempt, suite and the complete PNG digest inventory before upload.
Missing, stale, modified or partial failed-run captures cannot substitute for
successful execution. Reused artifact names include the attempt to avoid immutable
artifact collisions on a full rerun. Consumers use the attempt recorded by each
successful producer job, so a partial rerun can reuse that same run and revision's
earlier successful capture. They reject missing/future attempts and still verify
repository, revision, run, suite and every PNG digest; no cross-run fallback exists. The existing Sentry app IDs, comparison thresholds and
feature-gallery comparisons are retained. Background scroll normalization is
restored after capture; a bounded no-capture scroll witness also runs.

Main pushes and manual Sentry runs retain standalone capture. This deliberately
keeps exact-main baseline uploads and the existing `Feature docs refresh`
workflow lineage. Fork and Dependabot PRs retain browser qualification without
secret-bearing upload consumers. PR reuse adds no token permissions. Required
check names are unchanged; optional called snapshot/gallery checks acquire the
`Visual snapshot consumers` prefix and are not required contexts in the current
main ruleset.

`scripts/ci/selection.mjs` retains native/workspace and Synapse input coverage,
adds binding/feature-gallery witnesses, and selects all qualification for
unknown paths, unresolved diffs and shared dependencies/workflows. Rename diffs
include both source and destination. Tooling-only lint/format/Knip changes run
the frontend gate without unnecessary browser execution. Audits, licensing,
observability and release safeguards remain unconditional. The stable Rust
aggregate requires every selected job to succeed; a skipped or missing selected
job is a failure. Selector, result and artifact contracts run in the frontend
gate on every event.

The Linux integration lanes share only package setup, not services or tests.
They retain separate Synapse/Dex and MAS stacks. Package installation omits
unrelated recommendations. Existing recovery/persistence/cancellation commands
use the same compiler cache as their initial compilation, with read-only PR
credentials and main-only writes; no credential or cache policy changes.

Baseline observations before this cleanup: quality run `40401788799` consumed
51.75 summed unweighted job-minutes; snapshot run `40401788645` consumed 5.03,
including 4.6 minutes of repeated browser jobs. iOS run `40401788779` took 50.2
minutes for simulator, smoke and archive. Linux package setup varied up to 38.7
minutes in `40387786415`. These are individual observations, not percentiles,
billing estimates or a claimed speedup. Compare queue, setup, execution and
summed compute separately after hosted verification. iOS coverage and release
workflows are unchanged; browser consolidation alone cannot remove that critical
path.

## Tier 2 — Merge queue

Same checks as Tier 1, re-run against the synthetic tree GitHub's merge
queue builds. Last gate before a commit lands on `main`.

## Tier 3 — Nightly platform builds

Full native builds — macOS, Windows, Linux, iOS (simulator), Android — on a
daily cron plus manual dispatch, off the current tip of `main`.
**Non-blocking**: a failure opens/comments on a tracking GitHub issue rather
than gating anyone's work. Builds in release profile so the published
nightly and Sentry symbolication both reflect what actually ships.

## Release candidate preparation

Knope stages version changes and the changelog without pushing or editing a PR.
Android version-code synchronization and staging are separate commands; both the
staged result and the version-independent iOS fixtures are exercised in hosted CI.
The publication workflow enriches and formats the changelog before publication.

Automatic preparation uses a unique `release-candidate-<version>-<run_id>` branch.
The run ID remains stable across reruns. Existing branches and PR descriptions
are never deleted, overwritten or reused. The legacy `release` branch remains
supported only for PR541 at reviewed head
`17cc3908c89e10c167c4fa5f4c8cf69aa4491f89` and version `0.1.4`.
Any replacement head requires explicit eligibility reconciliation.
Preparation enumerates all candidate refs
and PRs and proceeds past an old ref only when its latest PR was conclusively
merged into this repository's main and its recorded head still matches that ref.
Open, closed-unmerged, advanced, partial or unreadable state stops preparation for
operator reconciliation. Closing a PR alone does not remove this guard.

Normal preparation is serialized and rechecks existing work before publication.
An unrelated actor may create another PR after a read; this is not a global atomic
lock on PR creation. Unique refs ensure that such a race cannot cause this workflow
to delete or overwrite the other actor's branch. Refreshing an existing candidate
still requires explicit reconciliation with current main and fresh checks.
The required frontend gate rejects unconsumed changesets when the candidate
changes the package version, including the combined merge-queue tree. The release
workflow repeats that check before creating a tag or draft, so a later main
changeset cannot silently ship with the preserved candidate's old metadata.

For an initial candidate, the existing GitHub App creates a GitHub-signed commit
with the captured main SHA as its expected parent. Publication verifies the
signature, parent, exact staged tree and branch head before opening a draft PR.
It never force-pushes or deletes a branch. A failed publication may leave a partial
candidate ref or draft: retain its exact SHA for operator review instead of
resetting or retrying over it. GitHub App signing of the commit does not establish
artifact signing or release approval. Existing
unsigned candidates require separate reconciliation; this workflow does not
rewrite their ancestry.

The preparation run uploads an immutable receipt identifying the repository,
branch, version, parent, exact candidate commit/tree, run ID and originating
attempt. A separate read-only release-eligibility job downloads that run's sole
receipt by artifact ID, rejects digest mismatches, and verifies the exact
successful main-push preparation attempt and signed candidate. A later failed
rerun does not invalidate a receipt from the successful original attempt. Missing,
expired or ambiguous receipts fail closed; receipts are retained for 90 days.
PR labeling failure emits a warning and does not prevent receipt creation; repair
the missing label through normal PR metadata review. Artifact upload is essential
provenance, so an upload failure retains the draft/ref for explicit operator
reconciliation. Automatic retries do not delete or overwrite that partial state
or invent replacement evidence for an unsuccessful originating attempt.
Only after eligibility and consumed-changeset validation succeed does the
publication job receive its existing write permissions and App token. A branch
prefix, PR body or signature alone is not candidate provenance. The legacy
same-repository `release` exception is bound to that exact PR541 candidate; generated
candidates use the existing bot/internal checklist policy, with no new prefix
exemption.

## Tier 4 — Production release _(signing-dependent)_

The release-PR workflow checks out the exact merge commit, creates or verifies the
version tag first, then creates or verifies the draft with GitHub-generated release
notes, and explicitly dispatches the tagged build. Knope continues to prepare
versions and the changelog in the release PR. The artifact
publisher requires a draft and never uses destructive asset replacement.
Interrupted uploads may resume only when existing files have identical SHA-256
digests. Different or unverifiable draft assets require explicit operator repair;
a published release requires a new version rather than replacement files.
Before publishing, the workflow verifies the complete remote asset count and
GitHub-reported SHA-256 digests against its locally signed artifact set. Upload
failure leaves an unpublished draft. Publication is serialized per version tag.
These workflow paths still require CI and a real release rehearsal; configuration
alone does not prove successful publication or recovery.

Triggered explicitly on the version tag after the generated release PR creates or
verifies its draft release. Standalone tag pushes are intentionally unsupported so
platform builds cannot finish with nowhere safe to publish. Debug-symbol/release-artifact
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
checks. The workflow imports the production certificate and submits the build
for notarization using credentials from the protected `release-signing`
environment. It intentionally prevents stable publication until those
credentials exist and real signed-artifact validation succeeds. Untagged
diagnostic dispatches and explicitly non-production nightlies retain their
existing policy.
These checks follow Apple's [code-signing verification guidance](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html)
and [notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).

Tagged Android builds require `ANDROID_KEYSTORE_JKS`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`.
The workflow imports that existing identity, supplies Gradle's release signing
configuration, verifies APK signatures and their SHA-256 signer fingerprint,
and strictly verifies AAB signatures against the configured keystore alias.
These checks use Android's [apksigner](https://developer.android.com/tools/apksigner)
and Java's [jarsigner](https://docs.oracle.com/en/java/javase/18/docs/specs/man/jarsigner.html).

Signing credentials are environment secrets only. Nightly identities belong in
the protected `nightly-signing` environment; distinct production identities
belong in `release-signing`. Do not also define this key material as repository
secrets, because branch-selected workflow YAML can access repository secrets
without crossing the protected signing-environment boundary.

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

The one-time signing-secret migration uses an operator-held encryption key that
expires on October 4, 2026, plus a one-day encrypted artifact. Regenerate that
recipient if the migration misses this bounded window. Required platform and GPG
key material must migrate as a complete set; `GPG_PASSPHRASE` migrates when the
private key is protected and may be absent only for an unencrypted key.

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

### Temporary updater ZIP backport qualification

The attributed `vendor/tauri-plugin-updater` crate keeps updater2.11.0 and the
current Tauri/iOS compatibility patches while adopting upstream's ZIP9 dependency
change. Its `CHARM_BACKPORT.md` records the immutable source, archive checksum,
license, exact production delta and removal condition. No updater endpoints or
signing policy change with this backport.

The read-only **Updater backport qualification** workflow tests the actual private
Windows extraction and installer-selection helpers with inert archives, without
calling an installer or exiting the app. It also checks valid/modified public
signature fixtures and ZIP's Unix permission/symlink boundary. Those Unix tests
qualify the dependency; Charm's Linux/macOS updater uses TAR rather than ZIP.
Existing audit thresholds and platform/release gates remain required. Preparing a
lockfile artifact is not acceptance: the artifact must be reviewed, committed and
tested at the resulting PR head. The temporary branch-only preparation job is removed after candidate adoption;
PR qualification remains until a supported upstream migration removes the backport.
