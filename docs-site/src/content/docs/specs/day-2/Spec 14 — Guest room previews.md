---
title: Charm 2.0 Spec — Guest room previews
type: spec
project: Charm 2.0
created: 2026-07-30
status: draft
---

**Workstream:** future day-2 discovery and implementation. Split from day-1
Spec 45 so guest/peek behavior does not block daily-driver registration and
account recovery.

## Problem & why later

Charm has no way to inspect a public or world-readable room before signing in.
A read-only preview could help a prospective user understand an invite or public
community, but it crosses a different trust and product boundary from account
registration: there may be no authenticated Matrix session, room history can be
hostile, and every write-capable control must remain absent.

## Initial scope

- Resolve a room alias or permalink and show only the summary/history the
  homeserver is permitted to disclose without a normal account.
- Render the preview in an explicitly unauthenticated shell.
- Hide or disable send, react, upload, join-as-member, moderation, settings,
  device, notification, and account actions.
- Offer a clear transition to sign in/register, preserving only the intended room
  reference rather than carrying preview state into the authenticated session.
- Prefer the Matrix room-preview APIs where supported. Do not create an
  `m.login.guest` account unless a later decision shows that server support and
  lifecycle cleanup are adequate.

## Non-goals

- Not part of Spec 45 registration, recovery, SSO, or token login.
- Not a promise that encrypted, invite-only, or non-world-readable history can be
  previewed.
- Not anonymous participation, guest message sending, or a durable guest account.

## Decision gates before implementation

1. Verify target homeserver support and the current Matrix room-preview contract.
2. Define the unauthenticated companion/Tauri transport without reusing an active
   account's client, caches, media credentials, or telemetry identity.
3. Threat-model hostile event/media rendering and cross-account cache leakage.
4. Specify the exact preview-to-login handoff and cleanup behavior.
5. Add a matching default-off Rust/TypeScript feature flag when implementation
   begins.

## Protocol references

- [Matrix Client-Server API: room previews](https://spec.matrix.org/latest/client-server-api/#room-previews)
- [Matrix Client-Server API: guest access](https://spec.matrix.org/latest/client-server-api/#guest-access)
