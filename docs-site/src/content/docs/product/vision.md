---
title: Product vision
description: What Charm is building, who it serves, and the product principles that shape the rewrite.
---

Charm is a ground-up Matrix client rewrite: the product remains a fast,
native-feeling, richly featured chat client, while the implementation moves
onto foundations that can support desktop, mobile, and the web without carrying
forward Charm 1's accumulated compatibility layers.

## What changes

- Matrix protocol, sync, crypto, and storage live in the shared Rust core built
  on `matrix-rust-sdk`.
- React consumes typed contracts instead of owning a second Matrix client in
  the webview.
- Native apps expose the Rust core through generated Tauri IPC bindings. The
  browser uses the same contracts through the Rust companion API.
- A semantic token system gives the product its own visual language and keeps
  platform adaptations coherent.
- Known sources of chronic complexity—an iframe-based calling stack, legacy
  branding shims, and the old composer architecture—are replaced rather than
  ported unchanged.

## Product promise

Charm should feel like a first-class application on every supported platform,
not a desktop page squeezed into different shells. That means:

- complete, reliable Matrix fundamentals before novelty;
- optimistic and offline-friendly messaging;
- encrypted history and recovery that survive normal device and browser
  lifecycles;
- accessible, responsive interaction from narrow mobile layouts to wide
  desktop windows;
- privacy-preserving observability, with user consent and explicit data
  boundaries;
- staged delivery through default-off feature flags, so incomplete work can be
  tested without becoming an accidental product promise.

## Target platforms

Charm supports macOS, Linux, Android, iOS, Windows, and the web. The native
targets share the Tauri/Rust core. The web target is a first-class deployment,
served through Cloudflare and backed by the Rust companion service where a
browser cannot run the native Matrix core directly.

The [architecture overview](/architecture/overview/) explains those runtime
boundaries. The [roadmap](/product/roadmap/) and [spec indexes](/specs/day-1/)
track the concrete capability set.

## Scope principle

The Day-1 and Day-2 labels are sequencing tools, not a quiet way to remove
features. A capability can move as dependencies become clearer, but a scope
change should be recorded in its repository spec and reviewed with the code
that depends on it.
