import { atom } from "jotai";

export type SettingsSection =
  | "account"
  | "notifications"
  | "devices"
  | "appearance"
  | "observability"
  | "general"
  | "desktop"
  | "focus"
  | "about"
  | "keyboard-shortcuts";

/** `null` when the settings shell is closed. Set by `openSettings`/`closeSettings`; never set directly outside this module. */
export const settingsOpenAtom = atom<SettingsSection | null>(null);

const VALID_SECTIONS: readonly SettingsSection[] = [
  "account",
  "notifications",
  "devices",
  "appearance",
  "observability",
  "general",
  "desktop",
  "focus",
  "about",
  "keyboard-shortcuts",
];

export function isSettingsSection(value: string): value is SettingsSection {
  return (VALID_SECTIONS as readonly string[]).includes(value);
}

/** `#/settings/<section>` — the stable, deep-linkable location for a given section. */
export function settingsHash(section: SettingsSection): string {
  return `#/settings/${section}`;
}

/**
 * Reads a `SettingsSection` out of `window.location.hash`, if present and
 * valid — e.g. `#/settings/devices` -> `"devices"`. Used both to open
 * settings deep-linked to a specific section on load, and to react to the
 * user navigating history (back/forward) while settings is open.
 */
export function parseSettingsHash(hash: string): SettingsSection | null {
  const match = /^#\/settings\/([a-z-]+)$/.exec(hash);
  if (!match) return null;
  const candidate = match[1];
  return isSettingsSection(candidate) ? candidate : null;
}

/**
 * Clears a lingering `#/settings/<section>` hash without pushing a history
 * entry — for sign-out/deactivate, which unmount `SettingsScreen` via
 * `onLoggedOut` directly rather than through `closeSettings`. Without this,
 * signing back in (as the same or a different account, in the same tab)
 * re-mounts `useSettingsHashSync`, which reads the still-present hash from
 * the previous session and immediately reopens settings.
 */
export function clearSettingsHash(): void {
  if (parseSettingsHash(window.location.hash)) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}
