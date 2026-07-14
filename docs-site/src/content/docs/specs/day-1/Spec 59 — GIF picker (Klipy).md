---
title: Charm 2.0 Spec — GIF picker (Klipy)
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent. New standalone spec (owner requested it be its
own). From the UI-parity deep-dive (2026-07-13), which fully reverse-engineered Charm
1.0's implementation.

## Problem & why now

Charm 1.0 has an in-composer GIF picker; Charm 2.0 has none (confirmed absent — no
GIF/sticker/emoji browse button in `Composer.tsx` at all). GIFs are a mainstream chat
expectation. **"Klippy" is Klipy** (`klipy.com`) — the third-party GIF-search API
Charm 1.0 uses (not a component/library name; there is no Tenor/Giphy).

## Non-goals

- Not the emoji picker (Spec 38) or custom-emoji/sticker packs (day-2 Spec 05) —
  though in Charm 1.0 GIF is a third tab in the same shared board (Emoji / Sticker /
  GIF); Charm 2.0 can mount the GIF picker in the same surface Spec 38 builds, as a
  tab, or as its own popover. Prefer sharing Spec 38's board for consistency.
- Not building a Charm-hosted GIF service — reuse Klipy + a proxy, matching 1.0.

## High-level design (grounded in Charm 1.0's implementation)

### Provider & config

- **Klipy REST API.** Search: `https://api.klipy.com/api/v1/{apiKey}/gifs/search?q=…&per_page=…`
  (Charm 1.0 `EmojiBoard.tsx:238-239`); parse results picking a size variant
  (`xs/sm/md/hd`) under a size limit → `{id, title, url, preview_url, width, height}`
  (`parseKlipyResult`, `:134-160`).
- **Config-gated**: requires a proxy URL + a real Klipy API key
  (`gifSearchConfigured`, `useClientConfig.ts:207-212`) plus an `enableGifPicker`
  user setting. Charm 2.0 needs the same config surface (proxy + key) — decide where
  these live (build/runtime config; the key must not ship in client source for a
  public build — route through the proxy, see below).

### Picker UX (match 1.0)

- **Discovery/trending**: pre-fetch one GIF per popular search term to build a
  browsable trending grid (`useGifDiscovery`, `:284-341`); cache across tab switches.
- **Search**: debounced, cancellable (`useGifSearch`, `:177-278`), with an error
  state and a `NoGifResults` empty state.
- **Recent searches** (per-user, persisted) and **popular-search** chips.
- **Favorites**: favorited GIFs stored in **Matrix account data** (so they sync
  across devices) and shown as a Favorites group (`useFavoriteGifs`). Charm 2.0
  should use the same account-data mechanism (coordinate with Spec 50 settings-sync
  patterns for the account-data write).
- **Grid render**: correct `aspect-ratio`, lazy-loaded images, mxc-or-CDN URL
  resolution.

### Send path (important — proxy + bridge compatibility)

- Send as **`msgtype: m.image`**. Fresh Klipy CDN URLs are rewritten to
  `mxc://{proxyHost}/{klipy_…}` so the **proxy caches** the asset (avoids hotlinking
  a third-party CDN and keeps it working long-term); favorited GIFs already carry an
  mxc. Charm 1.0 sets `body` to `name.gif` + `mimetype: image/webp` specifically so
  the Discord/mautrix bridge animates them — **replicate this** or bridged GIFs show
  as static.
- Carry reply relations / mentions like any other send; route through Charm 2.0's
  existing attachment/send path where possible.

### The proxy (owner-confirmed 2026-07-13: reuse Charm 1.0's)

- **Reuse Charm 1.0's existing GIF proxy as-is — it's a Cloudflare Worker,** already
  deployed and already fetching/caching Klipy assets + hiding the API key. Charm 2.0
  does **not** need to build or extend `charm-web-server` for this — point
  `gifs.proxyUrl` at the same existing Worker (confirm it isn't scoped to only
  accept requests from Charm 1.0's origin/auth; if it is, that's a small config
  change on the Worker side, not new infrastructure). This removes what was
  previously the main infra risk for this spec — no new service to design/host,
  just configuration + the client-side picker.
- Get the Worker's URL + the Klipy API key handling confirmed with whoever owns
  Charm 1.0's Cloudflare account/deployment before implementing.

## Data flow

Frontend calls the proxy (not Klipy directly, to hide the key and cache assets);
search/discovery results render in the picker; send rewrites the chosen GIF to an
mxc via the proxy and sends `m.image`. Favorites read/write Matrix account data.

## API/contract changes

- A GIF-proxy endpoint (server-side — `charm-web-server` or equivalent).
- Config for proxy URL + Klipy key (runtime/build config, key server-side only).
- Favorites via account data (frontend + account-data IPC).
- Send reuses the existing image-send path with the bridge-compat body/mimetype.

## Testing strategy

- Frontend: search debounce + cancel, trending grid, recent/popular chips, favorites
  add/remove (account-data round-trip), empty/error states, grid aspect-ratios.
- Send: chosen GIF sends `m.image` with the proxy-rewritten mxc and the
  `name.gif`/`image/webp` body for bridge animation; reply relation preserved.
- Proxy: caches a Klipy asset, serves it, doesn't leak the API key to the client.
- Manual + cross-client: send a GIF, confirm it animates in Charm 2.0 and (if a
  bridge is in play) in the bridged client.

## Trade-offs

- **Reuse Klipy + proxy vs switch provider**: reuse matches 1.0, keeps favorites/
  behavior consistent, and the proxy already exists to reuse. Swapping to Tenor/Giphy
  would be a different key/ToS and lose parity — not worth it unless Klipy is being
  dropped product-wide.
- **Share Spec 38's emoji board vs standalone popover**: sharing the board matches
  1.0's tabbed Emoji/Sticker/GIF surface and avoids a second picker chrome; do that
  if Spec 38 has landed, else a standalone GIF popover is fine interim.

## What I'd revisit as this grows

- Sticker tab in the same board (day-2 Spec 05 custom packs is the sticker home).
- GIF telemetry (Charm 1.0 has `gifTelemetry.ts` — Sentry breadcrumbs/timing) if
  usage needs monitoring.
