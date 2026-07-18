import { useEffect, useMemo, useRef, useState } from "react";
import { onTypingUpdate, sendTyping } from "@/lib/matrix";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { usePrivacySettings } from "@/features/settings/usePrivacySettings";
import { useFlag } from "@/featureFlags";

/** How often `sendTyping(true)` is re-sent while the user keeps typing, in ms. */
const TYPING_REFRESH_MS = 4000;

/**
 * How long the "X is typing…" row stays visible after the last `m.typing`
 * update with no follow-up, in ms. A sender's client is expected to send its
 * own `sendTyping(false)` when they stop, but this covers the case where it
 * doesn't (crash, network drop) so the indicator doesn't linger forever.
 *
 * Deliberately longer than `TYPING_REFRESH_MS`, not equal to it: a still-
 * typing sender's next refresh is throttled to fire at exactly that
 * interval, so an auto-hide timer set to the same value would race it —
 * this timer would fire the instant the sender's client is *first allowed*
 * to send its refresh, before that refresh has had time to travel over the
 * network and land here. The margin absorbs that latency so the row doesn't
 * flicker off and back on every refresh interval during continuous typing.
 */
export const TYPING_AUTO_HIDE_MS = TYPING_REFRESH_MS + 3000;

function typingLabel(userIds: string[]): string {
  if (userIds.length === 0) return "";
  if (userIds.length === 1) return `${userIds[0]} is typing…`;
  if (userIds.length === 2) return `${userIds[0]} and ${userIds[1]} are typing…`;
  const [first, second, ...rest] = userIds;
  return `${first}, ${second}, and ${rest.length} other${rest.length === 1 ? "" : "s"} are typing…`;
}

export function useChatTyping(roomId: string | null, currentUserId: string) {
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);
  const lastTypingSentAt = useRef(0);
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Review fix (P2): `handleTypingInput` used to send `typing: true` on
  // every keystroke regardless of this — the withdrawal effect below only
  // fires once, right when `hideTyping` flips on, but composer input can
  // keep arriving afterward (especially while a privacy write is still
  // queued or hasn't reached Rust yet) and would send a fresh public
  // typing notice moments after the user asked to hide it. Rust's own
  // `send_typing` enforcement does suppress it server-side once the
  // *persisted* setting has actually landed, but the optimistic window
  // between the toggle and that write settling is exactly what this
  // guards against — the UI already shows typing hidden, so it shouldn't
  // ask to send it at all in the meantime.
  //
  // Review fix (P2): also gated on `presence_privacy_controls` itself —
  // `usePrivacySettings`'s cache can still hold a stale `hide_typing: true`
  // from before the flag was turned off (Labs, or a remote kill switch),
  // and neither the query key nor its `enabled` state changes just because
  // the flag flipped, so a plain cache read alone doesn't notice. Without
  // this, a user with the feature already killed server-side (Rust's own
  // `current_settings` already falls back to defaults, and the Privacy tab
  // is hidden from Settings, so there's no in-app way to un-toggle it) would
  // still have every typing notice silently suppressed here until an
  // unrelated refetch happened to land.
  const detailControlsEnabled = useFlag("presence_privacy_controls");
  // Called unconditionally, per the rules of hooks — `detailControlsEnabled`
  // only gates whether its *result* is honored below, not whether the hook
  // itself runs.
  const privacySettings = usePrivacySettings();
  const hideTyping = detailControlsEnabled && (privacySettings.data?.hide_typing ?? false);

  useEffect(() => {
    // Clear on every room change, not just to `null` — otherwise switching
    // directly from room A (mid "X is typing…") to room B keeps A's typing
    // row rendered under B until B happens to get its own typing update.
    setTypingUserIds([]);
    clearTimeout(autoHideTimerRef.current);
    const typingRoomId = roomId;
    if (!typingRoomId) return undefined;
    // Guards against a listener callback that fires after this effect has
    // already torn down — `onTypingUpdate`'s `unlisten()` is itself async
    // (see the comment below), so a `typing:update` already in flight when
    // the room changes/unmounts can still invoke this callback once more
    // after cleanup. Without this, that late callback would both set state
    // on a hook instance that's moved on to a different room and schedule a
    // *new* auto-hide `setTimeout` that cleanup never gets a chance to
    // clear, which would later fire and clobber that different room's
    // typing state.
    let cancelled = false;
    // Keyed to the room id, not the `room` object — a `room_list:update`
    // refresh gives the active room a fresh object with the same id, which
    // would otherwise re-subscribe (and briefly double-listen, since the old
    // listener's teardown is async) on every refresh instead of only on an
    // actual room change.
    const unlisten = onTypingUpdate((update) => {
      if (cancelled) return;
      if (update.room_id !== typingRoomId) return;
      const filtered = update.user_ids.filter((id) => id !== currentUserId);
      setTypingUserIds(filtered);
      clearTimeout(autoHideTimerRef.current);
      if (filtered.length > 0) {
        autoHideTimerRef.current = setTimeout(() => {
          if (!cancelled) setTypingUserIds([]);
        }, TYPING_AUTO_HIDE_MS);
      }
    });
    return () => {
      cancelled = true;
      clearTimeout(autoHideTimerRef.current);
      unlisten.then((fn) => fn()).catch(logAndIgnore);
    };
  }, [roomId, currentUserId]);

  // Keyed to the room id, not the `room` object — RoomsScreen rebuilds
  // `activeRoom` from every `room_list:update`, so a plain `[room]` dep would
  // treat "same room, refreshed object" as a room change and send a spurious
  // `sendTyping(false)` while the user is still actively typing there.
  useEffect(() => {
    const typingRoomId = roomId;
    // A room switch (or unmount) resets the throttle too — otherwise typing
    // in room A within the last 4s can suppress the first `sendTyping(true)`
    // in room B, since the throttle was keyed globally rather than per room.
    lastTypingSentAt.current = 0;
    return () => {
      if (typingRoomId) sendTyping(typingRoomId, false).catch(logAndIgnore);
    };
  }, [roomId]);

  function handleTypingInput() {
    if (!roomId || hideTyping) return;
    const now = Date.now();
    if (now - lastTypingSentAt.current < TYPING_REFRESH_MS) return;
    lastTypingSentAt.current = now;
    sendTyping(roomId, true).catch(logAndIgnore);
  }

  // Review fix: `send_typing`'s own Rust enforcement (Spec 40) only
  // suppresses *future* typing sends once `hide_typing` is on — it can't
  // retroactively withdraw an `m.typing: true` notice already sent to
  // other room members before the toggle flipped. Without this, other
  // members keep seeing "is typing…" until the notice's own server
  // timeout, or until the composer blurs/the room changes, even though the
  // user just explicitly asked to hide it. `sendTyping(roomId, false)` is
  // documented as always going through (harmless if nothing was actually
  // pending), so this fires unconditionally on the toggle rather than
  // tracking whether a notice is actually outstanding.
  const wasHidingTyping = useRef(hideTyping);
  useEffect(() => {
    if (hideTyping && !wasHidingTyping.current && roomId) {
      sendTyping(roomId, false).catch(logAndIgnore);
    }
    wasHidingTyping.current = hideTyping;
  }, [hideTyping, roomId]);

  function stopTyping() {
    if (roomId) sendTyping(roomId, false).catch(logAndIgnore);
  }

  const typingText = useMemo(() => typingLabel(typingUserIds), [typingUserIds]);

  return { typingText, handleTypingInput, stopTyping };
}
