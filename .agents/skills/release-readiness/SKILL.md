---
name: release-readiness
description: Assess Charm desktop, mobile, and web artifacts for release readiness, integrity, security, privacy, signing, updater, and rollback risks. Use before nightly publication, tagged releases, store submission, updater rollout, or signing changes.
---

# Charm release readiness

Review the exact release commit and target channels. Do not handle or display private keys, passwords, or raw signing credentials.

Verify:

- required CI and target-platform builds on the release commit
- version, package, application, bundle, updater, and deep-link identifiers
- artifacts, checksums, signatures, notarization, and provenance
- dependency, CodeQL, secret, and static-analysis results
- SBOM generation and correspondence to each shipped artifact
- updater endpoints, manifests, signature verification, rollback, and failure behavior
- nightly and release-channel separation
- release notes, known issues, privacy disclosures, and telemetry defaults
- clean-install, upgrade, downgrade or rollback, login, sync, and logout smoke tests
- signing-key availability, backup, recovery ownership, rotation plan, and access boundary
- reproducibility limits and third-party service dependencies

Classify every item as pass, fail, blocked, not applicable, or manual verification required. Provide evidence links or command results. A missing required check is blocked, not assumed passing.

End with a release recommendation, blocking items, accepted risks requiring owner approval, rollback plan, and secrets required by name only.
