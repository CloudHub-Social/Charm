import { atom } from "jotai";
import { atomFamily } from "jotai/utils";
import type { PresenceUpdate } from "@/lib/matrix";

/**
 * One atom per `user_id`, holding the last `presence:update` seen for that
 * user (or `null` before anything has arrived). `atomFamily` keeps these
 * independent — a presence push for one user only re-renders components
 * reading that user's atom, not every presence consumer in the tree.
 */
export const presenceAtomFamily = atomFamily((userId: string) => {
  const userPresenceAtom = atom<PresenceUpdate | null>(null);
  userPresenceAtom.debugLabel = `presence:${userId}`;
  return userPresenceAtom;
});

/**
 * Applies an incoming `presence:update` push to the relevant per-user atom.
 * Call from a `set`-capable context (e.g. `useSetAtom` wired to
 * `onPresenceUpdate`) rather than importing the store directly, so this stays
 * testable without a real Tauri event.
 */
export function presenceUpdateAtom(update: PresenceUpdate) {
  return presenceAtomFamily(update.user_id);
}
