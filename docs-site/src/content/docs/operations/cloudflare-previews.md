---
title: Cloudflare previews
description: Per-PR Worker previews, same-origin API proxying, security boundaries, and failure modes.
---

Web-affecting pull requests receive an ephemeral Cloudflare Worker preview.
The preview serves the Vite static build and proxies `/api/*` to the deployed
Rust companion server, matching the same-origin shape used by the shared
development deployment.

## When a preview runs

`.github/workflows/web-preview.yml` listens to pull-request open, synchronize,
and reopen events, plus manual dispatch. A path filter deploys only when inputs
to `pnpm build:web` changed: frontend/public assets, generated bindings, Vite
and TypeScript configuration, env files, package metadata, or the preview
workflow itself.

If a later push removes all web-affecting changes, the workflow does not deploy
a misleading new bundle. Instead, it updates the existing preview comment to
say that the URL reflects an earlier commit.

## Build and deployment flow

1. `build-web-worker` installs dependencies and runs the web build.
2. It writes Cloudflare's static-asset headers, a Worker module, and
   `wrangler.jsonc` into a temporary bundle directory.
3. The Worker serves static assets and intercepts `/api/*`, preserving the
   path while proxying to `CHARM_WEB_API_BASE_URL`.
4. Wrangler uploads a version of the shared `charm-preview` Worker with a
   `pr-<number>` preview alias.
5. The workflow finds the emitted `workers.dev` URL and verifies
   `/api/auth/me` returns `401` without a session.
6. A stable `<!-- charm-web-preview -->` comment on the PR is created or
   updated with the URL.

The API check distinguishes useful failure classes:

| Status | Meaning |
| --- | --- |
| `401` | Expected: proxy and protected companion route both work. |
| `403` | The request reached an unexpected access/origin policy. |
| `404` | The Worker proxy is missing or the companion route is absent. |
| `502` | `CHARM_WEB_API_BASE_URL` is missing, invalid, or unreachable. |
| Other `5xx` | The Worker or origin failed; inspect both deployment logs. |

## Required configuration

The `cloudflare-preview` GitHub environment supplies:

- `CLOUDFLARE_API_TOKEN`;
- `CLOUDFLARE_ACCOUNT_ID`;
- `CHARM_WEB_API_BASE_URL`.

`VITE_SENTRY_DSN` is optional for PR previews. It is a public client key and
enables consent-gated runtime reporting, but its absence does not block a
preview.

## Sentry security boundary

PR previews never receive `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, or
`SENTRY_PROJECT`. Those credentials could create releases and upload source
maps, and exposing them during PR-controlled dependency installation or build
steps would give unreviewed code a chance to exfiltrate a write-capable token.

The shared development Worker on `main` uses the same bundle action but may
receive trusted Sentry upload credentials. It deploys to
`charm-2-dev.cloudhub.social`, creates a development release, and verifies the
same `/api/auth/me` contract.

## Cookie and origin behavior

The same-origin Worker proxy is intentional. Browser requests go to the
preview host's own `/api/*` path, allowing the companion server's
`SameSite=Strict` session cookie to participate in authenticated flows without
cross-site cookie exceptions.

The companion server must also allow the preview origin for credentialed CORS,
WebSocket upgrades, and raw-body requests. Use its constrained preview-host
wildcard support; never broaden the allowlist to every `workers.dev` host.

## Troubleshooting checklist

1. Confirm the `Detect web-affecting changes` job returned `true` for the
   current head SHA.
2. Confirm all three required Cloudflare/API settings are present in the
   `cloudflare-preview` environment.
3. Read the `versions upload` output and ensure it printed a `workers.dev` URL.
4. Test the preview's `/api/auth/me` before debugging application login.
5. If static assets load but API calls fail, inspect Worker proxy configuration
   and the companion server deployment separately.
6. If the PR comment says the preview is stale, push a web-affecting revision
   or run the workflow manually for the intended ref.

The production bundle implementation is shared in
[`build-web-worker/action.yml`](https://github.com/CloudHub-Social/Charm/blob/main/.github/actions/build-web-worker/action.yml),
while the two deployment policies live in
[`web-preview.yml`](https://github.com/CloudHub-Social/Charm/blob/main/.github/workflows/web-preview.yml)
and
[`web-deploy-dev.yml`](https://github.com/CloudHub-Social/Charm/blob/main/.github/workflows/web-deploy-dev.yml).

## Related documentation

- [Spec 16: web client architecture](/specs/day-1/spec-16--web-client-via-companion-matrix-server/)
  defines the browser-to-companion-server topology.
- [Spec 24: build identification](/specs/day-1/spec-24--build-and-release-identification-short-sha-pr-previews/)
  defines the PR-aware release identifier shown in previews and Sentry.
- [Rust companion API](../web-server/) documents the proxied origin, cookie,
  and allowlist contracts.
- [CI / release tiers](/contributing/ci-tiers/) places preview deployment in
  the larger pull-request gate.
