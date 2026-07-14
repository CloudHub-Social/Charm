---
title: Charm 2.0 Spec — Labs and experimental settings panel
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
---

**Workstream:** one PR / one agent. Addendum to Spec 08/18 (global settings) —
adds a settings section those specs didn't scope in.

## Problem & why now

Charm 1.0 has a populated `Experimental.tsx` labs panel exposing several
opt-in/preview features to users directly: personas, encrypted search, message
grouping, MSC4438 bookmarks, edit-in-input. Charm 2.0's global settings (Spec 18)
has no labs/experimental panel at all — there's no mechanism in the client for
shipping an in-progress feature behind a user-visible flag. As Charm 2.0's Day-2
work lands (threads, calling, custom emoji, etc. — see the day-2 spec set), the
lack of a labs mechanism means every new feature either has to ship fully-baked
day one or not be user-toggleable during a rollout/stabilization period at all.
This is a process/infrastructure gap as much as a feature gap.

## Non-goals

- Not a server-side/remote-config feature-flag system (e.g. LaunchDarkly-style)
  — a local, client-side settings panel matching Charm 1.0's actual scope: a list
  of named toggles, each gating a specific feature's visibility/behavior.
- Not porting Charm 1.0's *specific* flag list verbatim — its flags (personas,
  encrypted search, message grouping, MSC4438 bookmarks, edit-in-input) map to
  1.0's own feature set, some of which don't have Charm 2.0 equivalents yet (e.g.
  "encrypted search" maps conceptually to this vault's Spec 28, "MSC4438
  bookmarks" maps to day-2 Spec 12). This spec builds the **panel/mechanism**; each
  flag it exposes should be added by whichever spec introduces the underlying
  feature, not invented wholesale here.
- Not a way to circumvent the quality gate (Spec 08/18's existing settings IA,
  storybook-a11y, etc.) — labs-flagged UI still needs to pass the same
  accessibility/testing bar as anything else; "experimental" describes stability
  risk, not exemption from CI.

## High-level design

- New "Labs" (or "Experimental") section in global settings (Spec 18's IA),
  positioned as a distinct, clearly-labeled area separate from stable settings —
  matches the convention (and the implicit user expectation) that labs features
  may change or be removed without the same deprecation care as stable settings.
- Each flag: name, one-line description, on/off toggle, persisted in the same
  local settings store other client-local preferences use (Spec 09's theme,
  Spec 30's DND).
- A small shared primitive other specs can consume: `useLabFlag(flagId):
  boolean`-style hook (or equivalent) that any future feature's code can gate
  behind, plus a registration point (e.g. a `LAB_FLAGS` config list) new specs add
  an entry to when they want a staged/opt-in rollout, rather than each feature
  hand-rolling its own settings-store read.
- Initial flag set for this spec's own PR: intentionally small or even empty at
  ship time is acceptable — the panel/mechanism is the actual deliverable; if
  there's a concrete Charm-2.0-relevant flag ready to migrate in from an
  in-progress Day-2 spec at implementation time, include it, but don't invent
  placeholder flags with no real feature behind them.
- Clear-all / reset-labs action for support purposes (a user with a labs flag
  causing a problem should have an easy way to reset to default state without
  hunting through each toggle individually).

## Data flow

Purely local — flag state lives in the existing local settings persistence layer,
read via the shared hook wherever a gated feature's code checks it. No Matrix
sync, no IPC/Rust changes for the panel itself.

## API/contract changes

None for the panel/mechanism itself. Individual future specs that register a flag
may need their own IPC/backend changes, scoped to that spec, not this one.

## Testing strategy

- Frontend: labs panel renders registered flags, toggle persists across
  reload/restart, `useLabFlag` hook returns correct value for a fixture flag
  registration, reset-all action clears all flags to default.
- Storybook: labs panel states (empty list, several flags, some on/off) feeding
  the `storybook-a11y` gate — toggle controls need the same keyboard/contrast
  treatment as any other settings control.

## Trade-offs

- **Build the mechanism now with a possibly-empty initial flag list, rather than
  waiting until a specific feature needs it**: the audit found this gap
  specifically because it's infrastructure other Day-2 specs (threads, calling,
  custom emoji) will likely want to use for staged rollouts — building it now, as
  part of closing out Day-1 parity, avoids each of those specs having to bolt on
  its own ad hoc flag mechanism independently.

## What I'd revisit as this grows

- Per-flag telemetry (usage/error tracking scoped to labs-flagged code paths) if
  the labs mechanism sees real use and needs better visibility into whether an
  experimental feature is ready to graduate to stable.
- Server-side/remote flag override if client-side-only toggling proves
  insufficient for coordinating a staged rollout across many users at once.
