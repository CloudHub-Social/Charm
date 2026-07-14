---
title: Charm 2.0 Spec — App localization (i18n)
type: spec
project: Charm 2.0
created: 2026-07-13
status: draft
sidebar:
  label: "App localization"
---

**Workstream:** multi-PR (framework + extraction, then ongoing translation). New
spec from the 2026-07-13 owner adjudication. **Explicitly a stretch goal / low
priority** — tracked so it's not forgotten, not queued ahead of the core parity
work.

## Problem & why now

Charm 2.0's UI strings are hardcoded English. Neither Charm 1.0 nor Charm 2.0 has a
real app-locale switcher (Charm 1.0 only localizes pronoun display). Owner framing
(2026-07-13): pronoun pills are a firm requirement (handled in Spec 47), and **full
app localization is a stretch goal** — desirable eventually, not a launch blocker.
This spec captures the shape of that work so it can be picked up when prioritized,
and so new UI code can be written localization-aware in the meantime.

## Non-goals

- Not translating content (users' messages) — that's the domain of the messages
  themselves; this is *UI chrome* localization only.
- Not shipping a full set of translations in the first PR — the deliverable is the
  **framework + string externalization + one or two reference locales**, with
  community/ongoing translation following.
- Not blocking or reordering core parity specs (28-50) — this sits behind them.

## High-level design

- **i18n framework:** adopt a standard React i18n library (e.g. the ecosystem norm
  such as `react-i18next` / `lingui` / `formatjs` — pick one; check bundle size and
  whether anything is already in the dependency tree). Externalize UI strings into
  message catalogs keyed by locale.
- **String extraction:** replace hardcoded strings with translation keys across the
  app. This is the bulk of the effort and is mechanical-but-large — worth doing
  incrementally (new/changed components become localization-aware first; a sweep
  externalizes the rest over time).
- **Locale selection:** a settings control to choose app language (follows OS locale
  by default), persisted as a **synced** setting (Spec 50 — a user's chosen language
  should follow them across devices).
- **RTL support:** right-to-left layout for RTL locales (Arabic, Hebrew) — CSS
  logical properties / `dir` handling. Flag as part of doing i18n properly, not an
  afterthought.
- **Pluralization & interpolation:** use the framework's plural/interpolation
  handling rather than string concatenation (chat UIs have many "N messages"/"N
  people typing" cases — Spec 05's typing indicator, Spec 39's membership collapse,
  etc.).
- **Number/date/time formatting:** route through locale-aware `Intl` formatting
  (ties to Spec 47's 12h/24h and date-format settings — reconcile so locale defaults
  and explicit overrides coexist sensibly).

## Data flow

Pure frontend. Message catalogs are bundled (or lazy-loaded per locale). Selected
locale persists via the settings store (synced per Spec 50). No IPC/Rust changes —
though any user-facing strings originating Rust-side (error messages surfaced to the
UI) should be keys/codes the frontend localizes, not pre-formatted English, so
audit those.

## API/contract changes

None Rust-side, ideally. Rust→frontend error surfaces should carry codes the
frontend can localize rather than English prose (may require small changes to how
some errors are surfaced — note during implementation).

## Testing strategy

- Framework smoke test: switching locale re-renders strings; missing-key fallback to
  the default locale; plural/interpolation cases render correctly.
- RTL: a spot-check that RTL locale flips layout direction without breaking key
  screens.
- Lint/CI: a check that flags hardcoded user-facing strings in new code (keeps the
  externalization from regressing once started).

## Trade-offs

- **Stretch-goal framing**: deliberately deprioritized behind core parity — but doing
  the *framework* early (even before translations exist) means new UI is written
  localization-aware, avoiding a much larger retrofit later. So: consider landing the
  framework + extraction-conventions early even if actual translations come later.
- **Which i18n library**: pick by bundle size + maintenance + plural/RTL support;
  don't hand-roll (pluralization and RTL are exactly where hand-rolled i18n breaks).

## What I'd revisit as this grows

- Community translation workflow (Weblate/Crowdin-style) once the framework exists
  and there's demand for many locales.
- Locale-specific formatting edge cases (calendars, name ordering) if target locales
  need them.
