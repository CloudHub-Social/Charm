import { atom } from "jotai";
import { boundedAtomFamily } from "@/lib/boundedAtomFamily";

/** Distinct rooms tracked at once — see `boundedAtomFamily`'s doc comment. */
const MAX_TRACKED_ROOMS = 100;

export type RoomSettingsSection = "general" | "members" | "permissions";

export interface RoomSettingsTarget {
  roomId: string;
  section: RoomSettingsSection;
}

/**
 * Which room's settings modal is open, and which left-nav section it should
 * land on — a single global atom (not per-room) since only one room's
 * settings modal can be open at a time, mirroring Charm 1.0's
 * `roomSettingsAtom` (`useOpenRoomSettings()`), which can deep-link straight
 * to a page like `RoomSettingsPage.MembersPage`.
 */
export const roomSettingsAtom = atom<RoomSettingsTarget | null>(null);

/**
 * Whether the lightweight always-on member-browse drawer (mirroring Charm
 * 1.0's `MembersDrawer.tsx`) is open for a given room, keyed by `room_id` via
 * `atomFamily` so switching rooms doesn't leak the drawer's open/closed state
 * between them — same convention as `messageActionAtoms.ts`'s per-room atoms.
 */
export const membersDrawerOpenAtomFamily = boundedAtomFamily((_roomId: string) => {
  void _roomId;
  return atom(false);
}, MAX_TRACKED_ROOMS);
