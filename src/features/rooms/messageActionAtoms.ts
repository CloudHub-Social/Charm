import { atom } from "jotai";
import { boundedAtomFamily } from "@/lib/boundedAtomFamily";
import type { ReplyRef } from "@/lib/matrix";

/** Distinct rooms tracked at once — see `boundedAtomFamily`'s doc comment. */
const MAX_TRACKED_ROOMS = 100;

/**
 * The message the composer is currently replying to, per room. `null` means
 * the composer is in its default (non-reply) mode. Keyed by `room_id` via
 * `atomFamily` so switching rooms doesn't leak reply state between them.
 */
export const activeReplyTargetAtomFamily = boundedAtomFamily((_roomId: string) => {
  void _roomId;
  return atom<ReplyRef | null>(null);
}, MAX_TRACKED_ROOMS);

/**
 * The event id of the message currently being edited in the composer, per
 * room. `null` means the composer is in its default (non-edit) mode.
 */
export const editingEventIdAtomFamily = boundedAtomFamily((_roomId: string) => {
  void _roomId;
  return atom<string | null>(null);
}, MAX_TRACKED_ROOMS);

/**
 * Fallbacks for `ChatShell`'s `activeReplyTargetAtomFamily`/
 * `editingEventIdAtomFamily` lookups when it renders with no room (`room`
 * prop `null`, before its own early return) — plain atoms outside the
 * bounded families so that transient no-room render never occupies (and
 * potentially evicts) one of `MAX_TRACKED_ROOMS` real rooms' tracked state.
 * See `noRoomMembersDrawerOpenAtom` in `roomInfoAtoms.ts` for the same
 * pattern applied to the members drawer.
 */
export const noRoomActiveReplyTargetAtom = atom<ReplyRef | null>(null);
export const noRoomEditingEventIdAtom = atom<string | null>(null);
