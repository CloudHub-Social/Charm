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

/**
 * Fallback for `useAtom(membersDrawerOpenAtomFamily(...))` call sites that
 * can render with no active room (e.g. `RoomsScreen` before any room is
 * selected). Deliberately a plain atom outside the family rather than
 * calling the family with a placeholder key like `""` — doing that would
 * still occupy one of `MAX_TRACKED_ROOMS` slots, and once created it could
 * eventually get evicted-into (or itself cause the eviction of) a real
 * room's tracked entry.
 */
export const noRoomMembersDrawerOpenAtom = atom(false);

/**
 * Whether the pinned-messages panel (Spec day-2/04) is open for a given
 * room — same per-room-atomFamily convention as
 * `membersDrawerOpenAtomFamily` above. The right panel is a single slot
 * (see `RoomsScreen`), so opening this closes the members drawer and vice
 * versa; the two atoms are independent booleans rather than one shared
 * "which panel" enum purely to keep this additive to the existing members
 * drawer wiring rather than restructuring it.
 */
export const pinnedMessagesDrawerOpenAtomFamily = boundedAtomFamily((_roomId: string) => {
  void _roomId;
  return atom(false);
}, MAX_TRACKED_ROOMS);

/** Fallback for `pinnedMessagesDrawerOpenAtomFamily` — see `noRoomMembersDrawerOpenAtom`'s doc comment. */
export const noRoomPinnedMessagesDrawerOpenAtom = atom(false);
