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
}) {
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
  messagesByRoom.set(seed.room.room_id, []);

  function findMessage(roomId: string, eventId: string) {
    return messagesByRoom.get(roomId)?.find((m) => m.event_id === eventId);
  }

  function pushTimelineUpdate(roomId: string, messages: Record<string, unknown>[]) {
    emit("timeline:update", { room_id: roomId, messages });
  }

  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    try_restore_session: () => ({ user_id: seed.userId, device_id: seed.deviceId }),
    list_rooms: () => [seed.room],
    resolve_room_alias: () => seed.room.room_id,
    get_timeline_page: (args) => ({
      messages: messagesByRoom.get(args.roomId as string) ?? [],
      next_cursor: null,
    }),
    mark_room_read: () => undefined,
    send_typing: () => undefined,
    can_redact: () => true,

    send_message: (args) => {
      const roomId = args.roomId as string;
      const transactionId = `txn-${nextTxnId++}`;
      const eventId = `\$${nextEventId++}`;
      const message = {
        event_id: eventId,
        sender: seed.userId,
        body: args.body,
        formatted_body: null,
        timestamp_ms: Date.now(),
        edited: false,
        redacted: false,
        reactions: [],
        in_reply_to: null,
        transaction_id: transactionId,
        send_state: { state: "sent" },
      };
      messagesByRoom.get(roomId)?.push(message);
      // Real backend behavior: the transaction id is returned immediately
      // (queued), and the synced event arrives asynchronously afterwards.
      queueMicrotask(() => pushTimelineUpdate(roomId, [message]));
      return transactionId;
    },

    send_reply: (args) => {
      const roomId = args.roomId as string;
      const target = findMessage(roomId, args.inReplyToEventId as string);
      const transactionId = `txn-${nextTxnId++}`;
      const eventId = `\$${nextEventId++}`;
      const message = {
        event_id: eventId,
        sender: seed.userId,
        body: args.body,
        formatted_body: null,
        timestamp_ms: Date.now(),
        edited: false,
        redacted: false,
        reactions: [],
        in_reply_to: target
          ? { event_id: target.event_id, sender: target.sender, preview: target.body }
          : null,
        transaction_id: transactionId,
        send_state: { state: "sent" },
      };
      messagesByRoom.get(roomId)?.push(message);
      queueMicrotask(() => pushTimelineUpdate(roomId, [message]));
      return transactionId;
    },

    edit_message: (args) => {
      const roomId = args.roomId as string;
      const message = findMessage(roomId, args.eventId as string);
      if (message) {
        message.body = args.newBody;
        message.edited = true;
        pushTimelineUpdate(roomId, [message]);
      }
      return undefined;
    },

    redact_event: (args) => {
      const roomId = args.roomId as string;
      const message = findMessage(roomId, args.eventId as string);
      if (message) {
        message.redacted = true;
        message.body = "";
        pushTimelineUpdate(roomId, [message]);
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
        pushTimelineUpdate(roomId, [message]);
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
