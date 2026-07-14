---
title: "Charm 2.0 Spec — Theming and appearance"
type: spec
project: Charm 2.0
created: "2026-07-04"
status: shipped
---

**Workstream:** one PR / one agent. **Tier:** Day-1 launch-critical.

## Problem & why now

Charm is dark-first by design and ships with a token system that already exists in
`src/styles/tokens.css` (primitive → semantic → component tiers, plus a shadcn/Radix
alias layer feeding Tailwind v4 `@theme inline`). But there is no runtime theme
switching, only one hard-coded light override, no flash-free application of the user's
choice at boot, and no appearance UI. A Matrix chat client is a long-dwell surface;
theme, font size, message density, and a motion opt-out are table-stakes accessibility
and comfort settings that must land Day-1. We also need the token layer to be the
single source consumed everywhere so later work (custom themes, Day-3) is additive, and
we need the sync contract with **Claude Design** (system of record) pinned down before
more components are built against ad-hoc values.

## Current state (in repo)

- `src/styles/tokens.css` — three tiers implemented: primitive (`--gray-*`, `--accent-*`,
  scales, durations `--duration-fast|base|slow` = 120/200/280ms, `--touch-target-min:44px`,
  `--radius-md:8px`, `--space-*` 4px base, `--font-sans` Manrope / `--font-mono` JetBrains
  Mono), semantic (dark defaults on `:root`), one `[data-theme="light"]` override block,
  component tier, shadcn alias layer, and Tailwind `@theme inline` wiring. Fonts come from
  `@fontsource/manrope` + `@fontsource/jetbrains-mono`.
- Tailwind v4 via `@tailwindcss/vite`; utilities resolve through `@theme inline`.
- `radix-ui` + `class-variance-authority` + `clsx` + `tailwind-merge` + `lucide-react`
  present. No `next-themes`-style manager; nothing sets `data-theme` at runtime.
- Feature-flag concept exists (`flags.json` + `tauri-plugin-store` + `get_flags()` +
  `flags:update` + `useFeatureFlag()`) — appearance persistence should reuse the store
  plugin, not invent a parallel mechanism.
- No `tauri-plugin-store` dependency wired yet; no appearance atoms, no settings panel.

## Scope (in)

1. Finish the **token layer** as the sole styling source: audit/normalize primitive →
   semantic → component tiers, ensure every shipped component consumes semantic/component
   tokens (never primitives directly), document the tier contract inline.
2. **Flash-free `[data-theme]` switching**: resolve and apply the theme attribute on
   `<html>` **before first paint** via an inline boot script (no FOUC/flash-of-wrong-theme),
   then live-switch by mutating `data-theme`.
3. **2–3 built-in themes**: `dark` (default), `light` (promote existing override), and one
   more — `midnight` (higher-contrast OLED-black / deeper accent) — each a `[data-theme="…"]`
   override block over the semantic tier only.
4. **Appearance settings** state + hooks + atoms: theme picker, **font size** (S/M/L/XL
   scale), **message density** (compact/cozy), explicit **reduced-motion** toggle
   (`system` | `on` | `off`) overriding OS.
5. **Persistence** of all appearance choices via `tauri-plugin-store` (mirrors flags),
   restored before first paint. (Account-level appearance sync via Matrix
   `im.vector.setting`-style account data is a follow-up, noted as non-goal.)
6. **Claude Design sync**: pin the contract for how token values originate in Claude Design
   (system of record) and are pulled into `tokens.css` (design originates, code pulls).

## Non-goals (out)

- **Custom user theming** via token overrides / theme editor — Day-3, explicitly out.
- Per-room or per-account theme overrides.
- Account-data sync of appearance across devices (server-side) — follow-up.
- Automatic OS light/dark following as the *only* option — we support a `system` choice but
  the default remains explicit dark-first.
- The physical appearance **panel chrome** lives in the Settings spec (Spec 08); this spec
  owns the token/theme engine + the appearance state/hooks the panel renders.

## Design & approach

### Token layer
- Keep the existing three-tier structure. Enforce the rule: components read
  **semantic/component** tokens (`--color-bg-*`, `--color-text-*`, `--color-accent`, the
  shadcn aliases) and Tailwind utilities resolved via `@theme inline`; primitives
  (`--gray-*`) never appear in component CSS/JSX.
- Add **density** and **font-size** as component-tier CSS custom properties driven by
  `data-*` attributes on `<html>`: e.g. `[data-density="compact"]` sets
  `--message-row-padding-y: var(--space-1)`, `cozy` → `var(--space-2)`;
  `[data-font-size="lg"]` scales a `--font-scale` multiplier consumed by a `rem` base on
  `:root`. Motion honors both `@media (prefers-reduced-motion)` **and** a
  `[data-reduced-motion="on"]` attribute that zeroes `--duration-*`.
- New themes are additive `[data-theme="light"|"midnight"]` blocks overriding only the
  semantic tier (never primitives), so Tailwind wiring is untouched.

### Flash-free application
- Add a tiny synchronous inline `<script>` in `index.html` `<head>` (before the module
  bundle) that reads the persisted appearance from the store snapshot and sets
  `document.documentElement.dataset.theme / density / fontSize / reducedMotion` before the
  first paint. Because `tauri-plugin-store` reads are async, persist a **synchronous mirror**
  to `localStorage` on every change (write-through) and read that mirror in the boot script;
  treat `tauri-plugin-store` as the source of truth reconciled on mount. This keeps the boot
  path dependency-free and flash-free while the store remains authoritative.

### Frontend components/hooks/atoms
- `src/features/appearance/atoms.ts` — Jotai atoms: `themeAtom` (`'dark'|'light'|'midnight'|'system'`),
  `fontSizeAtom`, `densityAtom`, `reducedMotionAtom`. A write-through effect atom applies the
  DOM attributes and mirrors to `localStorage` + `tauri-plugin-store`.
- `src/features/appearance/useAppearance.ts` — hook exposing current values + setters; used by
  the Settings appearance panel (Spec 08).
- `src/features/appearance/ThemeProvider.tsx` — mounts the reconcile-on-load effect and
  subscribes to store changes (multi-window consistency).
- `resolveSystemTheme()` — uses `window.matchMedia('(prefers-color-scheme: dark)')` when the
  choice is `system`.

### Rust / Tauri
- Add `tauri-plugin-store` (Rust) + `@tauri-apps/plugin-store` (JS); register the plugin in
  `src-tauri/src/lib.rs` and add its permission to `src-tauri/capabilities/default.json`
  (`store:default`). Appearance persists in `appearance.json` (separate store from
  `flags.json`). No new `#[tauri::command]` strictly required (JS store plugin reads/writes
  directly), but expose a `get_appearance()` command + `appearance:update` event if/when
  account-data sync lands (kept as an extension point, not built now).

### ts-rs IPC types
- If a Rust-owned appearance struct is introduced for future account-data sync, define
  `Appearance { theme, font_size, density, reduced_motion }` as
  `#[derive(Serialize, Deserialize, TS)] #[ts(export, export_to = "../src/bindings/")]`
  mirroring the existing `RoomSummary` / `SyncStateEvent` pattern in `matrix/mod.rs`. For
  Day-1, TS types live in the frontend since persistence is JS-side.

### Claude Design sync contract
- **Claude Design is the system of record.** Token *values* (color ramps, radii, spacing,
  durations, semantic mappings, per-theme overrides) originate there. `tokens.css` is a
  generated artifact: a `pnpm tokens:pull` script pulls the current design system export
  from Claude Design (via the design MCP `read_file`/`list_files` on the Charm design
  project) and regenerates the primitive + semantic tiers of `tokens.css`. Hand-edits to
  generated regions are disallowed (marked with `/* GENERATED — edit in Claude Design */`
  banners); the component tier and Tailwind wiring remain hand-authored. CI diff-checks that
  a fresh pull produces no changes (drift guard).

## Acceptance criteria

1. On cold launch with a persisted non-default theme, the app renders in that theme with
   **no visible flash** of the default/dark theme (verify by screenshot-diff of first frame).
2. Switching theme in appearance settings updates the UI live (no reload) by mutating
   `data-theme`, and the change survives an app restart.
3. Three built-in themes (`dark`, `light`, `midnight`) are selectable and each overrides only
   the semantic tier; `dark` is the default when no choice is stored.
4. `system` theme choice follows the OS and reacts to OS light/dark changes at runtime.
5. Font-size setting (S/M/L/XL) rescales message and UI text via `--font-scale`; density
   (compact/cozy) changes message row padding; both persist across restart.
6. Reduced-motion toggle set to `on` zeroes transition/animation durations even when the OS
   does not request reduced motion; set to `system` it defers to `prefers-reduced-motion`.
7. No component source references a primitive `--gray-*`/`--accent-*` token directly (lint/grep
   guard passes).
8. `pnpm tokens:pull` regenerates `tokens.css` from Claude Design and CI drift-check passes on
   a clean checkout.
9. `pnpm build` (`tsc && vite build`) succeeds with no errors; axe reports no contrast
   violations for text tokens in all three themes.

## Testing

- **Vitest + RTL**: `useAppearance` setters mutate `document.documentElement.dataset.*`;
  atoms write-through to a mocked store + `localStorage`; `resolveSystemTheme` reacts to a
  mocked `matchMedia`. Coverage floor enforced.
- **Storybook + screenshot-diff**: a "Themes" story renders the component gallery under each
  `data-theme` × density × font-size combination; screenshot-diff catches token regressions.
- **axe** run per theme in Storybook for contrast/reduced-motion assertions.
- **Boot/flash test (Playwright + tauri-driver)**: seed a persisted `midnight` choice, launch,
  assert first painted frame is `midnight` (no dark flash) via early screenshot.
- **Drift check (CI)**: `pnpm tokens:pull` then `git diff --exit-code src/styles/tokens.css`.

## Dependencies & sequencing

- Requires `tauri-plugin-store` wired (shared with the feature-flag system — coordinate so
  both land the store plugin once).
- Consumes the Claude Design Charm project export; needs the design MCP token export finalized.
- **Blocks / feeds** Spec 08 (Settings) — the appearance panel imports `useAppearance`.
- Independent of Specs 10/11.

## Risks & open questions

- **Flash-free boot** depends on a synchronous mirror (`localStorage`) since the store plugin
  is async; risk of mirror/store divergence — mitigated by write-through + reconcile-on-mount.
  Open: is a Rust-side synchronous read (returning appearance in the initial HTML) preferable
  to the localStorage mirror on mobile webviews?
- **Claude Design export format** for tokens (JSON? CSS?) and the pull mechanism (MCP call vs
  committed export) need to be pinned; the drift-check assumes deterministic generation.
- Third theme identity (`midnight` vs a warm/sepia option) is a design call owned by Claude Design.
- Tailwind v4 `@theme inline` recomputation cost on live theme switch — verify no layout jank.
- **Confirmed contrast debt (from the 2026-07-05 design-sync render of the UI primitives):**
  several components render **light-on-transparent** and rely on a dark ancestor, so they
  vanish / go low-contrast on a light surface — specifically **Label** (no color class →
  inherits light `foreground`), the **ghost** and **link** **Button** variants (no
  background), and **disabled + placeholder Input text** (muted gray on transparent). This
  is the same family as the `color-contrast` axe failures currently scoped out of the
  Storybook a11y gate (see `.storybook/preview.tsx` and Spec 11… i.e. the a11y CI note).
  **Acceptance for this spec must include:** these components pass WCAG AA on **both** the
  dark and light themes, and the `color-contrast` axe rule is re-enabled in the a11y gate
  once fixed. Not a bug in the current dark-first app (which never renders on a light
  surface today), but a hard requirement the moment the light theme ships.

## Effort estimate

**M** — token engine + flash-free boot + three themes + appearance atoms/hooks is a
contained frontend workstream; the Claude Design pull pipeline and drift-check add the extra
integration weight that pushes it above small.
