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
