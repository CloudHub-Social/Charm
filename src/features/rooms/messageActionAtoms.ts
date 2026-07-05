import { atomFamily } from "jotai/utils";
import { atom } from "jotai";
import type { ReplyRef } from "@/lib/matrix";

/**
 * The message the composer is currently replying to, per room. `null` means
 * the composer is in its default (non-reply) mode. Keyed by `room_id` via
 * `atomFamily` so switching rooms doesn't leak reply state between them.
 */
export const activeReplyTargetAtomFamily = atomFamily((_roomId: string) => {
  void _roomId;
  return atom<ReplyRef | null>(null);
});

/**
 * The event id of the message currently being edited in the composer, per
 * room. `null` means the composer is in its default (non-edit) mode.
 */
export const editingEventIdAtomFamily = atomFamily((_roomId: string) => {
  void _roomId;
  return atom<string | null>(null);
});
