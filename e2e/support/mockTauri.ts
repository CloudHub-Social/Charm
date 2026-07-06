/**
 * Fakes just enough of `@tauri-apps/api`'s IPC contract
 * (`window.__TAURI_INTERNALS__.invoke`/`transformCallback`) to run the real
 * app against an in-memory fake backend in a plain browser — there's no
 * native Tauri host or homeserver here, only the Vite dev server. Injected
 * via `page.addInitScript(installMockTauri, seed)` so it exists before the
 * app's own bundle runs (the app calls `try_restore_session` synchronously
 * on mount).
 *
 * This must be a single self-contained function: Playwright serializes it
 * with `Function.prototype.toString()` and evals it in the page, so it
 * can't close over anything from the test file or import other modules.
 *
 * Command coverage is deliberately narrow — just what `App`/`RoomsScreen`/
 * `ChatShell` call during login, room list, timeline load, and the
 * send/react/edit/reply/delete message-actions flow. Anything else resolves
 * to `undefined` rather than throwing, so an unrelated call (e.g. a
 * lifecycle effect this suite doesn't exercise) doesn't crash the page.
 */
declare global {
  interface Window {
    __TAURI_INTERNALS__: {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
      transformCallback: (callback: (payload: unknown) => void, once?: boolean) => number;
      unregisterCallback: (id: number) => void;
      convertFileSrc: (filePath: string) => string;
    };
  }
}

export function installMockTauri(seed: {
  userId: string;
  deviceId: string;
  room: { room_id: string; name: string | null; unread_count: number };
  members?: { user_id: string; display_name: string | null }[];
  roomDetails?: Record<string, unknown>;
}) {
  // `RoomSummary` grew several Spec-06 org fields (favourite/muted/space/etc)
  // that `list_rooms` must always return a complete shape for — `RoomList.tsx`
  // reads them unconditionally (e.g. `parent_space_ids.includes(...)`), so a
  // partial seed room would throw rather than just rendering unfavourited/
  // unmuted defaults.
  const room = {
    unread_messages: seed.room.unread_count,
    is_marked_unread: false,
    is_muted: false,
    is_favourite: false,
    is_low_priority: false,
    manual_order: null,
    is_space: false,
    parent_space_ids: [],
    is_direct: false,
    has_unread: seed.room.unread_count > 0,
    ...seed.room,
  };
  type Listener = (payload: unknown) => void;

  const listenersByEvent = new Map<string, Set<number>>();
  const callbacksById = new Map<number, Listener>();
  let nextCallbackId = 1;

  function emit(event: string, payload: unknown) {
    const ids = listenersByEvent.get(event);
    if (!ids) return;
    for (const id of ids) {
      callbacksById.get(id)?.({ event, payload, id });
    }
  }

  // Exposed so the test can drive server-pushed events directly when a
  // scenario needs to simulate something the fake command handlers below
  // don't already emit as a side effect.
  // oxlint-disable-next-line no-underscore-dangle
  (window as unknown as { __e2eEmit: typeof emit }).__e2eEmit = emit;

  let nextTxnId = 1;
  let nextEventId = 1;
  const messagesByRoom = new Map<string, Record<string, unknown>[]>();
  messagesByRoom.set(room.room_id, []);

  function findMessage(roomId: string, eventId: string) {
    return messagesByRoom.get(roomId)?.find((m) => m.event_id === eventId);
  }

  // `timeline:update` is a full re-snapshot of the room's live Timeline
  // (Spec 14), not a delta — `ChatShell` replaces its whole message list
  // with whatever this carries. So this always emits the room's complete
  // current message set, not just whichever message a handler just touched.
  // Emits a fresh array copy, not `messagesByRoom.get(roomId)` directly: that
  // array is mutated in place (e.g. replacing a pending echo with its sent
  // counterpart by index) — passing the *same* array reference back into
  // `setMessages` after mutating it means React's state setter sees
  // `Object.is(next, prev)` as true and bails out of re-rendering entirely,
  // even though the array's contents changed. A fresh array reference each
  // call avoids that footgun and matches how the real IPC layer would
  // deliver a genuinely new array over the wire anyway.
  function pushTimelineUpdate(roomId: string) {
    emit("timeline:update", { room_id: roomId, messages: [...(messagesByRoom.get(roomId) ?? [])] });
  }

  // Spec 07's room-info panel — `roomDetails` is mutated in place by the
  // setter handlers below and re-emitted via `room_details:update`, mirroring
  // the real sync loop's "state event lands -> re-read -> emit" flow (no
  // optimistic UI on the Rust side, so the mock shouldn't have any either).
  const roomDetails: Record<string, unknown> = {
    room_id: room.room_id,
    name: room.name,
    topic: null,
    avatar_url: null,
    is_encrypted: false,
    join_rule: "invite",
    history_visibility: "shared",
    member_count: (seed.members?.length ?? 0) + 1,
    my_power_level: 100,
    power_levels: {
      invite: 0,
      kick: 50,
      ban: 50,
      redact: 50,
      events_default: 0,
      state_default: 50,
      users_default: 0,
    },
    can: {
      set_name: true,
      set_topic: true,
      set_avatar: true,
      set_join_rules: true,
      set_history_visibility: true,
      set_encryption: true,
      set_power_levels: true,
      invite: true,
      kick: true,
      ban: true,
    },
    ...seed.roomDetails,
  };

  const memberList: Record<string, unknown>[] = (seed.members ?? []).map((member) => ({
    avatar_url: null,
    power_level: 0,
    membership: "join",
    ...member,
  }));

  function pushRoomDetailsUpdate() {
    emit("room_details:update", { ...roomDetails });
  }

  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    try_restore_session: () => ({ user_id: seed.userId, device_id: seed.deviceId }),
    list_rooms: () => [room],
    resolve_room_alias: () => room.room_id,
    get_timeline_page: (args) => ({
      messages: messagesByRoom.get(args.roomId as string) ?? [],
      next_cursor: null,
    }),
    mark_room_read: () => undefined,
    send_typing: () => undefined,
    can_redact: () => true,
    get_room_members: () => seed.members ?? [],
    run_command: () => ({ status: "success" }),

    get_room_details: () => ({ ...roomDetails }),
    get_room_member_list: () => [...memberList],
    set_room_name: (args) => {
      roomDetails.name = args.name;
      room.name = args.name as string | null;
      pushRoomDetailsUpdate();
      // Real sync also re-snapshots the room list on any state change —
      // the chat header and `RoomList` both read the room's name from
      // `RoomSummary`, not `RoomDetails`, so this keeps them in sync too
      // (see Spec 07 acceptance criteria 2).
      emit("room_list:update", [room]);
      return undefined;
    },
    set_room_topic: (args) => {
      roomDetails.topic = args.topic;
      pushRoomDetailsUpdate();
      return undefined;
    },
    set_room_join_rule: (args) => {
      roomDetails.join_rule = args.joinRule;
      pushRoomDetailsUpdate();
      return undefined;
    },
    set_room_history_visibility: (args) => {
      roomDetails.history_visibility = args.visibility;
      pushRoomDetailsUpdate();
      return undefined;
    },
    enable_room_encryption: () => {
      roomDetails.is_encrypted = true;
      pushRoomDetailsUpdate();
      return undefined;
    },
    invite_member: (args) => {
      memberList.push({
        user_id: args.userId,
        display_name: null,
        avatar_url: null,
        power_level: 0,
        membership: "invite",
      });
      roomDetails.member_count = (roomDetails.member_count as number) + 1;
      pushRoomDetailsUpdate();
      return undefined;
    },
    kick_member: (args) => {
      const member = memberList.find((m) => m.user_id === args.userId);
      const wasActive = member?.membership === "join" || member?.membership === "invite";
      if (member) member.membership = "leave";
      if (wasActive) roomDetails.member_count = (roomDetails.member_count as number) - 1;
      pushRoomDetailsUpdate();
      return undefined;
    },
    ban_member: (args) => {
      const member = memberList.find((m) => m.user_id === args.userId);
      const wasActive = member?.membership === "join" || member?.membership === "invite";
      if (member) member.membership = "ban";
      if (wasActive) roomDetails.member_count = (roomDetails.member_count as number) - 1;
      pushRoomDetailsUpdate();
      return undefined;
    },
    // A real homeserver leaves an unbanned user in `leave`, not `join` — they
    // aren't automatically re-added to the room, so `member_count` (active
    // members only) doesn't change either.
    unban_member: (args) => {
      const member = memberList.find((m) => m.user_id === args.userId);
      if (member) member.membership = "leave";
      pushRoomDetailsUpdate();
      return undefined;
    },
    set_member_power_level: (args) => {
      const member = memberList.find((m) => m.user_id === args.userId);
      if (member) member.power_level = args.powerLevel;
      pushRoomDetailsUpdate();
      return undefined;
    },
    set_room_power_level_thresholds: (args) => {
      roomDetails.power_levels = args.changes;
      pushRoomDetailsUpdate();
      return undefined;
    },

    // Models the real `Timeline`'s two-phase local echo (Spec 14): a
    // `timeline:update` carrying the item with `send_state: "pending"` and
    // its (temporary) transaction-id `event_id` fires first — synchronously,
    // like the real `Timeline` reacting to the send queue's `NewLocalEvent`
    // — then a second `timeline:update` replaces it in place with the real
    // `$...` event id and `send_state: "sent"`, mirroring the homeserver's
    // remote echo arriving. `message-actions.spec.ts`'s "shows exactly one
    // bubble" test asserts against exactly this sequence.
    send_message: (args) => {
      const roomId = args.roomId as string;
      const transactionId = `txn-${nextTxnId++}`;
      const eventId = `\$${nextEventId++}`;
      const pending = {
        event_id: transactionId,
        sender: seed.userId,
        body: args.body,
        formatted_body: args.formattedBody ?? null,
        timestamp_ms: Date.now(),
        edited: false,
        redacted: false,
        reactions: [],
        in_reply_to: null,
        transaction_id: transactionId,
        send_state: { state: "pending" },
      };
      messagesByRoom.get(roomId)?.push(pending);
      pushTimelineUpdate(roomId);
      const sent = { ...pending, event_id: eventId, send_state: { state: "sent" } };
      setTimeout(() => {
        const messages = messagesByRoom.get(roomId);
        const index = messages?.indexOf(pending) ?? -1;
        if (messages && index !== -1) messages[index] = sent;
        pushTimelineUpdate(roomId);
      }, 300);
      return transactionId;
    },

    send_reply: (args) => {
      const roomId = args.roomId as string;
      const target = findMessage(roomId, args.inReplyToEventId as string);
      const transactionId = `txn-${nextTxnId++}`;
      const eventId = `\$${nextEventId++}`;
      const inReplyTo = target
        ? { event_id: target.event_id, sender: target.sender, preview: target.body }
        : null;
      const pending = {
        event_id: transactionId,
        sender: seed.userId,
        body: args.body,
        formatted_body: null,
        timestamp_ms: Date.now(),
        edited: false,
        redacted: false,
        reactions: [],
        in_reply_to: inReplyTo,
        transaction_id: transactionId,
        send_state: { state: "pending" },
      };
      messagesByRoom.get(roomId)?.push(pending);
      pushTimelineUpdate(roomId);
      const sent = { ...pending, event_id: eventId, send_state: { state: "sent" } };
      setTimeout(() => {
        const messages = messagesByRoom.get(roomId);
        const index = messages?.indexOf(pending) ?? -1;
        if (messages && index !== -1) messages[index] = sent;
        pushTimelineUpdate(roomId);
      }, 300);
      return transactionId;
    },

    edit_message: (args) => {
      const roomId = args.roomId as string;
      const message = findMessage(roomId, args.eventId as string);
      if (message) {
        message.body = args.newBody;
        message.edited = true;
        pushTimelineUpdate(roomId);
      }
      return undefined;
    },

    redact_event: (args) => {
      const roomId = args.roomId as string;
      const message = findMessage(roomId, args.eventId as string);
      if (message) {
        message.redacted = true;
        message.body = "";
        pushTimelineUpdate(roomId);
      }
      return undefined;
    },

    toggle_reaction: (args) => {
      const roomId = args.roomId as string;
      const message = findMessage(roomId, args.targetEventId as string);
      const key = args.key as string;
      let action = "added";
      if (message) {
        const reactions = message.reactions as {
          key: string;
          count: number;
          reacted_by_me: boolean;
        }[];
        const existing = reactions.find((r) => r.key === key);
        if (existing?.reacted_by_me) {
          existing.count -= 1;
          existing.reacted_by_me = false;
          message.reactions = reactions.filter((r) => r.count > 0);
          action = "removed";
        } else if (existing) {
          existing.count += 1;
          existing.reacted_by_me = true;
        } else {
          reactions.push({ key, count: 1, reacted_by_me: true });
        }
        pushTimelineUpdate(roomId);
      }
      return { action };
    },
  };

  // oxlint-disable-next-line no-underscore-dangle
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "plugin:event|listen") {
        const event = args?.event as string;
        const handlerId = args?.handler as number;
        if (!listenersByEvent.has(event)) listenersByEvent.set(event, new Set());
        listenersByEvent.get(event)!.add(handlerId);
        return Promise.resolve(handlerId);
      }
      if (cmd === "plugin:event|unlisten") {
        const event = args?.event as string;
        listenersByEvent.get(event)?.delete(args?.eventId as number);
        return Promise.resolve(undefined);
      }
      const handler = handlers[cmd];
      return Promise.resolve(handler ? handler(args ?? {}) : undefined);
    },
    transformCallback: (callback: Listener, once?: boolean) => {
      const id = nextCallbackId++;
      const wrapped: Listener = once
        ? (payload) => {
            callbacksById.delete(id);
            callback(payload);
          }
        : callback;
      callbacksById.set(id, wrapped);
      return id;
    },
    unregisterCallback: (id: number) => {
      callbacksById.delete(id);
    },
    convertFileSrc: (filePath: string) => filePath,
  };
}
