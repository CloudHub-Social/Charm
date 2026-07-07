import { atom } from "jotai";
import type { BadgeState } from "@/lib/matrix";

/**
 * Last-seen `badge:update` push, or `null` before the first sync iteration
 * has run. Native badges (dock/taskbar/tray) are driven Rust-side from the
 * same aggregation — this atom only feeds the in-app rail counts, so both
 * never drift out of sync with each other.
 */
export const badgeAtom = atom<BadgeState | null>(null);

/**
 * Pure mapping from an incoming `badge:update` payload to the value
 * `badgeAtom` should hold — kept separate from the actual `listen()` wiring
 * (see `useBadgeListener`) so this stays testable without a real Tauri event.
 */
export function badgeUpdateValue(update: BadgeState): BadgeState {
  return update;
}
