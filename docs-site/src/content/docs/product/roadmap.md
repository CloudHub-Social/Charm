---
title: Product roadmap
description: How Charm sequences daily-driver scope, follow-on capabilities, and platform work.
---

Charm's roadmap is maintained as reviewable specs rather than a calendar
promise. Each spec records scope, dependencies, acceptance criteria, and its
current implementation status. Pull requests that materially change a feature
also update the corresponding spec.

## Day 1: daily-driver foundation

Day-1 work establishes the complete daily-driver experience and the platform
infrastructure it relies on. It includes identity and onboarding, timelines and
message composition, rooms and spaces, moderation and settings, media, crypto
recovery, notifications, responsive layouts, observability, release identity,
and feature-flagged delivery.

The [Day-1 index](/specs/day-1/) is the detailed source for shipped, in-progress,
and drafted work. Its status column is intentionally more authoritative than a
summary duplicated here.

## Day 2: depth and parity

Day-2 work adds capabilities that depend on a stable daily-driver foundation or
need a larger product surface: threads, calling, polls, pinning, custom emoji
and stickers, public-room discovery, location sharing, media editing,
multi-account switching, history export, jump-to-date, bookmarks, and delayed
send.

See the [Day-2 index](/specs/day-2/) for the dependency and implementation
details.

## Platform work

Platform delivery runs across the feature tiers:

1. Prove shared behavior in the Rust core and typed contracts.
2. Integrate native capabilities in each Tauri target.
3. Integrate the browser through Cloudflare and the Rust companion API.
4. Capture deterministic feature journeys and operational evidence in CI.
5. Roll out behind flags, then retire flags after a stable general release.

## Changing the roadmap

A roadmap change belongs in the repository when it affects product scope,
architecture, dependencies, acceptance criteria, or shipped status. Personal
notes can explore an idea, but they do not supersede the reviewed spec.

The [documentation workflow](/contributing/documentation/) describes how to
make and validate those changes.
