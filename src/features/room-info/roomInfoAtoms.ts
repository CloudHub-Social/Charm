import { atom } from "jotai";
import { atomFamily } from "jotai/utils";

/**
 * Whether the right panel (`RoomInfoPanel`) is open for a given room, keyed
 * by `room_id` via `atomFamily` so switching rooms doesn't leak the panel's
 * open/closed state between them — same convention as
 * `messageActionAtoms.ts`'s per-room atoms.
 */
export const rightPanelOpenAtomFamily = atomFamily((_roomId: string) => {
  void _roomId;
  return atom(false);
});
