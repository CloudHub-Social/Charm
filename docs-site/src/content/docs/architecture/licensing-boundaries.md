---
title: Licensing and external-widget boundaries
description: What Charm's Apache-2.0 license covers and how external AGPL widgets remain separate.
---

Charm's original source code and documentation are licensed under Apache-2.0.
That license does not relicense dependencies, fonts, operating-system
components, hosted services, or other third-party works. The root
`LICENSING.md`, `THIRD_PARTY_NOTICES.md`, build-generated
`THIRD_PARTY_LICENSES.txt`, lockfiles, and release SBOMs describe the
corresponding inventories and notices.

This page is an architectural and release policy, not legal advice. It is
load-bearing for Spec 49 (widgets), Spec 02 (calling), and any App Store build.

## Sable Call audit record

The reviewed Sable Call source was the public `SableClient/SableCall`
repository at revision `a93dd8b410b18502b62f1149ee382e2582393649`, retrieved
2026-09-05. Its README offers the work under AGPLv3 or later and the repository
also carries a commercial-license notice referring to a valid Element
commercial license.

| Audit area | Finding |
| --- | --- |
| Provenance | Sable Call is a fork of `element-hq/element-call`; the reviewed revision and license links are pinned in `THIRD_PARTY_NOTICES.md`. No code, assets, build output, queries, or workflows were imported into Charm. |
| Maintenance | The reviewed repository had a release and commit on 2026-07-30. That is evidence of recent activity, not a maintenance guarantee. |
| Dependencies | It is a substantial React/Vite application with embedded and SDK builds, Matrix and Widget API packages, LiveKit, media-processing code, and observability dependencies. It is not a small client library. |
| Fork delta | GitHub's cross-fork comparison was unavailable during the audit, so this record makes no claim that it enumerates every Sable change from Element Call. Re-audit the exact deployment before integration. |
| Advisories | The repository published no GitHub security advisories at review time. Dependabot alert data was disabled or inaccessible, so the transitive dependency risk is unresolved rather than clean. |
| Architectural fit | Its embedded web build fits Charm's sandboxed widget model. Its build system and media stack do not fit Charm's Tauri/Rust package boundary and must not be absorbed into it. |
| Commercial terms | The repository's commercial notice alone does not establish rights to Sable-specific changes. Bundling therefore remains prohibited unless rights covering the exact work are documented. |

## Required runtime boundary

Charm may integrate with Sable Call only as external software:

1. Sable Call is deployed and operated separately on an HTTPS origin. Charm
   does not build or publish that deployment as part of an app release.
2. Charm loads the deployment as a sandboxed Matrix widget and communicates
   only through the documented Widget API `postMessage` protocol and explicitly
   granted Matrix capabilities.
3. Charm does not vendor, compile, statically or dynamically link, package,
   mirror, prefetch for offline use, or redistribute Sable Call source, assets,
   JavaScript bundles, branding, or container images.
4. A Charm artifact remains complete without Sable Call code. Calling may be
   unavailable without network access to the external deployment, but the app
   package must not contain a fallback copy.
5. The Sable Call operator must display the applicable copyright and
   third-party notices and provide users a standard, no-charge way to obtain
   the exact corresponding source, including source for deployed modifications.
6. Charm identifies the external provider in its own notices without implying
   that Sable Call is Apache-licensed or part of Charm.

The CI `license:check` guard preserves the repository side of this boundary by
rejecting Sable Call dependencies, packaging inputs, packaged assets, and
non-document material that would be redistributed in release source archives.

## Widget security and privacy boundary

Licensing separation does not make an external widget trustworthy. The widget
implementation must also:

- validate the iframe origin and bind every Widget API session to the expected
  window, origin, account, and room;
- default to no capabilities and persist only the exact grant the user approved;
- show a provider-specific consent prompt before sharing room, identity,
  microphone, camera, screen, TURN, or event data;
- keep secrets, unrestricted native IPC, filesystem access, process access, and
  arbitrary Tauri commands outside the widget bridge;
- isolate widget storage and grants between Matrix accounts and revoke them on
  sign-out, widget removal, or origin change;
- make origin changes and newly requested capabilities require fresh approval;
- provide a visible close/leave control and make lifecycle teardown testable.

## App Store release gate

Before a build containing widget support is submitted to an app store, the
release owner must record evidence for the current store rules. For Apple's
current [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/),
the relevant areas include self-contained apps (2.5.2), HTML5 mini apps and
plug-ins (4.7), privacy and user permission, age rating and indexing, and the
right to display or access third-party services (5.2).

For Apple-distributed builds, Charm must therefore:

- enable Sable Call only behind a feature flag that defaults off until the
  reviewed release decision enables it;
- select widget origins from a reviewed, versioned allowlist; generic
  add-by-URL remains a direct desktop/web feature unless the store grants a
  broader model;
- request explicit, provider-named consent before disclosing data or granting
  microphone, camera, screen, or Matrix-event capabilities;
- expose no native API to downloaded code beyond the reviewed, scoped Widget
  API bridge;
- provide the required discoverability/index, universal-link, moderation,
  privacy-policy, support, and age-rating metadata where the store rules apply;
- verify the external provider's distribution rights, privacy disclosures,
  source availability, and operational ownership for the exact production
  origin; and
- repeat the review when the origin, bridge capabilities, hosted application,
  or store rules materially change.

Passing this repository's license check does not satisfy those release gates or
predict store approval.

## Changing the boundary

Bundling, caching, importing, or shipping Sable Call requires a separate,
reviewed decision before implementation. That review must establish either
commercial permission covering both the Element Call base and the exact
Sable-specific modifications, or another documented grant from every relevant
rightsholder. It must also update notices, SBOM generation, source-offer duties,
store declarations, threat modeling, and rollback plans. An Apache-2.0 header
on Charm files cannot substitute for those rights.

## Verification checklist

- `license:check` passes in GitHub Actions.
- Release artifacts contain Charm's `LICENSE`, `NOTICE`, third-party notice
  index, and build-generated dependency license texts. The independently built
  documentation-site artifact carries the same files for its resolved graph.
  Source archives contain the committed root license and notice files.
- Artifact inspection finds no Sable Call bundle, asset, dependency, container,
  or offline cache.
- Integration tests exercise denied capabilities, origin mismatch, account
  switching, grant revocation, teardown, and a separately hosted test widget.
- The production Sable Call deployment exposes its exact corresponding source
  and notices.
- Store-specific evidence is attached to the release-readiness review.
