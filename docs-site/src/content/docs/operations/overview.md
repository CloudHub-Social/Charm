---
title: Platform operations
description: Charm's deployed services, environments, ownership boundaries, and verification paths.
---

Charm has three separately deployed public surfaces: the web frontend, its
companion Matrix API, and this documentation site. They share a repository but
have different runtimes, secrets, and release cadences.

```d2
direction: right

Browser: {
  shape: person
}
Cloudflare Worker: {
  label: "Cloudflare Worker\nstatic app + /api proxy"
}
Companion API: {
  label: "charm-web-server\nDigitalOcean App Platform"
}
Homeserver: {
  label: "Matrix homeserver"
}
GitHub Pages: {
  label: "GitHub Pages\npublic docs"
}
Sentry: {
  label: "Sentry\nruntime + release evidence"
}

Browser -> Cloudflare Worker: "HTML / CSS / JS"
Cloudflare Worker -> Companion API: "/api/*"
Companion API -> Homeserver: "matrix-rust-sdk"
Browser -> GitHub Pages: "developer docs"
Browser -> Sentry: "consented browser events"
Cloudflare Worker -> Sentry: "operator-configured logs + traces"
Companion API -> Sentry: "operator-enabled backend events"
```

## Deployment surfaces

| Surface | Runtime | Trigger | Primary verification |
| --- | --- | --- | --- |
| Pull-request web preview | `charm-preview` Cloudflare Worker preview alias | A PR changes web build inputs | Preview comment exists; unauthenticated `/api/auth/me` returns `401` |
| Shared development web app | `charm` Cloudflare Worker at `charm-2-dev.cloudhub.social` | A web-affecting push reaches `main` | Worker deploy succeeds; proxied `/api/auth/me` returns `401` |
| Companion API | DigitalOcean App Platform from `.do/app.yaml` | A server/shared-Rust change reaches `main` | `/api/health` returns `200`; protected `/api/devices` returns `401` without a session |
| Public docs | GitHub Pages at `charm-docs.cloudhub.social` | A docs change reaches `main`, a release completes, or the scheduled spec sync runs | Pages deploy succeeds; generated root CSS/JS URLs return their real content types |

## Ownership boundaries

- **Cloudflare owns the browser edge.** The Worker serves Vite's static
  output and proxies `/api/*` to the companion origin so browser requests are
  same-origin and `SameSite=Strict` session cookies work.
- **The companion server owns Matrix sessions.** It maps an opaque `HttpOnly`
  cookie to a `matrix_sdk::Client`, runs sync loops, and exposes the shared
  Matrix operations over HTTP and WebSocket.
- **DigitalOcean owns the process lifecycle, not durable state.** App Platform
  instances are replaceable. Encrypted session records and crypto snapshots
  live in private Spaces buckets; the local data directory is ephemeral.
- **Sentry is an evidence plane, not an application dependency.** Client
  telemetry remains default-off and user-consent-gated. Worker logs and traces
  use separately configured Cloudflare observability destinations, while
  backend telemetry is enabled only when the operator supplies a server DSN.
- **GitHub Actions is the deployment control plane.** Checked-in workflows and
  app specs describe deployment behavior; secrets remain in GitHub,
  DigitalOcean, Cloudflare, Spaces, or Doppler rather than the repository.

## Where to go next

- [Sentry observability](../sentry/) covers runtime consent, scrubbing,
  release artifacts, and visual snapshots.
- [Rust companion API](../web-server/) covers local operation, session
  security, persistence, and the DigitalOcean deployment.
- [Cloudflare previews](../cloudflare-previews/) covers per-PR Worker builds,
  API proxying, preview comments, and troubleshooting.
- [CI / release tiers](../../contributing/ci-tiers/) explains which checks
  gate pull requests, merge-queue commits, nightlies, and releases.

:::note[Canonical configuration]
The workflows and service source are authoritative. These pages explain how
the pieces fit together and link to the files to inspect when behavior changes.
:::
