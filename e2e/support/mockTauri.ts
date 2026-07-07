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
  otherDevices?: { device_id: string; display_name: string | null; is_verified: boolean }[];
  roomDetails?: Record<string, unknown>;
  /**
   * `false` for onboarding.spec.ts's "brand-new account" scenario — every
   * other spec keeps the default (rooms present) so Spec 12's onboarding
   * gate resolves straight to "done" and never mounts `OnboardingScreen`
   * where it isn't the thing under test.
   */
  hasRooms?: boolean;
  /**
   * Additional rooms beyond `room` — used by room-list-org.spec.ts to
   * exercise sectioning (favourites/rooms/low-priority/spaces) across a
   * small multi-room list. Each entry is layered onto the same default
   * shape `room` gets, so a partial room object here is safe too.
   */
  extraRooms?: Record<string, unknown>[];
  /**
   * The local file path `plugin:dialog|open` resolves to, simulating the
   * user picking a file in the native picker — media-attachments.spec.ts
   * drives the attach-button flow this way since there's no real OS dialog
   * to drive from a plain browser. `null`/omitted resolves to `null`
   * (simulating the user cancelling the picker), matching the real
   * `open()` contract `ChatShell.handleAttachClick` already guards on.
   */
  filePickerResult?: string | null;
  /** `list_space_children` results, keyed by the space's `room_id`. */
  spaceChildren?: Record<string, Record<string, unknown>[]>;
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
    notification_mode: "all_messages",
    is_favourite: false,
    is_low_priority: false,
    manual_order: null,
    is_space: false,
    parent_space_ids: [],
    is_direct: false,
    has_unread: seed.room.unread_count > 0,
    avatar_url: null,
    avatar_path: null,
    dm_peer_user_id: null,
    ...seed.room,
  };
  const defaultRoomShape = {
    unread_count: 0,
    unread_messages: 0,
    is_marked_unread: false,
    is_muted: false,
    notification_mode: "all_messages",
    is_favourite: false,
    is_low_priority: false,
    manual_order: null,
    is_space: false,
    parent_space_ids: [],
    is_direct: false,
    has_unread: false,
    avatar_url: null,
    avatar_path: null,
    dm_peer_user_id: null,
  };
  const extraRooms: Record<string, unknown>[] = (seed.extraRooms ?? []).map((extra) => {
    const merged = { ...defaultRoomShape, ...extra };
    const unreadCount = merged.unread_count ?? 0;
    return {
      ...merged,
      unread_messages: extra.unread_messages ?? unreadCount,
      has_unread: extra.has_unread ?? unreadCount > 0,
    };
  });
  const allRooms: Record<string, unknown>[] = [room, ...extraRooms];
  const spaceChildren = new Map(Object.entries(seed.spaceChildren ?? {}));
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
  for (const r of allRooms) {
    messagesByRoom.set(r.room_id as string, []);
  }

  // Spec 12 (onboarding): both persistence layers the gate hook checks,
  // in-memory only — no reload-survives-relaunch simulation here, since a
  // page reload re-runs this whole init script from scratch anyway.
  const accountData = new Map<string, unknown>();
  let localOnboardingFlag = false;

  // Spec 08 (settings): minimal in-memory state for the account/devices/
  // notifications commands — just enough to drive the logout and
  // verify-another-session e2e flows; not a full settings-panel fake.
  let profile = { user_id: seed.userId, display_name: null as string | null, avatar_url: null };
  const devices = [
    { device_id: seed.deviceId, display_name: "This browser", is_verified: true },
    ...(seed.otherDevices ?? []),
  ];
  let crossSigningBootstrapped = true;
  const notificationSettings = {
    default_mode: "all_messages",
    keywords: [] as string[],
    global_mute: false,
    sound_enabled: true,
  };

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

  function findRoom(roomId: string): Record<string, unknown> | undefined {
    return allRooms.find((r) => r.room_id === roomId);
  }

  function pushRoomListUpdate() {
    emit("room_list:update", [...allRooms]);
  }

  // Spec 05: read receipts, typing, presence. Deliberately not modeling a
  // second real user session — these commands just accept the send and
  // clear the room's unread state; `__e2eEmit` is how a test simulates the
  // *incoming* side (another user's receipt/typing/presence) since there's
  // no second client in this fake to produce it organically.

  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    try_restore_session: () => ({ user_id: seed.userId, device_id: seed.deviceId }),
    list_rooms: () => (seed.hasRooms === false ? [] : allRooms),
    get_own_profile: () => ({
      user_id: profile.user_id,
      display_name: profile.display_name,
      avatar_url: profile.avatar_url,
      avatar_path: null,
      presence: "online",
    }),
    get_account_data: (args) => accountData.get(args.eventType as string) ?? null,
    set_account_data: (args) => {
      accountData.set(args.eventType as string, args.content);
      return undefined;
    },
    get_local_onboarding_flag: () => localOnboardingFlag,
    set_local_onboarding_flag: () => {
      localOnboardingFlag = true;
      return undefined;
    },
    resolve_room_alias: () => room.room_id,
    get_timeline_page: (args) => ({
      messages: messagesByRoom.get(args.roomId as string) ?? [],
      next_cursor: null,
    }),
    mark_room_read: (args) => {
      const targetRoom = findRoom(args.roomId as string);
      if (targetRoom) {
        targetRoom.unread_count = 0;
        targetRoom.unread_messages = 0;
        targetRoom.is_marked_unread = false;
        targetRoom.has_unread = false;
        pushRoomListUpdate();
      }
      return undefined;
    },
    send_typing: () => undefined,
    can_redact: () => true,
    get_room_members: () => seed.members ?? [],
    run_command: () => ({ status: "success" }),

    // Spec 02: media and attachments.
    send_attachment: (args) => {
      const roomId = args.roomId as string;
      const filePath = args.filePath as string;
      const txnId = args.txnId as string;
      const filename = filePath.split(/[/\\]/).pop() ?? filePath;
      const eventId = `\$${nextEventId++}`;
      const isImage = /\.(png|jpe?g|gif|webp)$/i.test(filename);
      const isVideo = /\.(mp4|webm|mov)$/i.test(filename);
      const isAudio = /\.(mp3|wav|ogg|m4a)$/i.test(filename);
      const media = isImage
        ? {
            type: "Image",
            mime: "image/png",
            size: 12345,
            width: 800,
            height: 600,
            has_thumbnail: true,
            blurhash: null,
          }
        : isVideo
          ? {
              type: "Video",
              mime: "video/mp4",
              size: 54321,
              width: 1280,
              height: 720,
              duration_ms: 4200,
              has_thumbnail: true,
            }
          : isAudio
            ? { type: "Audio", mime: "audio/mpeg", size: 22222, duration_ms: 3000 }
            : { type: "File", filename, mime: "application/octet-stream", size: 99999 };
      // Emits upload:progress twice (partial then complete) before the sent
      // message lands, so a test can assert the progress bar both appears
      // and clears — mirroring the real send-queue's incremental progress
      // events (see `UploadProgress`'s doc comment).
      emit("upload:progress", { txn_id: txnId, room_id: roomId, sent: 50, total: 100 });
      const sent = {
        event_id: eventId,
        sender: seed.userId,
        sender_display_name: null,
        sender_avatar_url: null,
        sender_avatar_path: null,
        body: filename,
        formatted_body: null,
        timestamp_ms: Date.now(),
        edited: false,
        redacted: false,
        reactions: [],
        in_reply_to: null,
        transaction_id: txnId,
        send_state: { state: "sent" },
        media,
      };
      messagesByRoom.get(roomId)?.push(sent);
      emit("upload:progress", { txn_id: txnId, room_id: roomId, sent: 100, total: 100 });
      pushTimelineUpdate(roomId);
      return undefined;
    },
    resolve_media: () =>
      // A tiny same-origin placeholder path — `convertFileSrc` is a no-op in
      // this mock (`installMockTauri`'s own `convertFileSrc: (p) => p`
      // below), so whatever this returns is used directly as an `<img>`/
      // `<video>`/`<a href>` src. A data URI keeps the lightbox/thumbnail
      // actually renderable without needing a real static asset on disk.
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",

    // Spec 05: read receipts, typing, presence.
    send_read_receipt: () => undefined,
    set_presence: () => undefined,
    get_presence: () => null,

    // Spec 06: room-list organization (favourite/low-priority/mute/mark-
    // unread/manual-order) and spaces (list children + join/knock).
    set_room_favourite: (args) => {
      const targetRoom = findRoom(args.roomId as string);
      if (targetRoom) {
        targetRoom.is_favourite = args.favourite;
        if (args.favourite) targetRoom.is_low_priority = false;
        pushRoomListUpdate();
      }
      return undefined;
    },
    set_room_low_priority: (args) => {
      const targetRoom = findRoom(args.roomId as string);
      if (targetRoom) {
        targetRoom.is_low_priority = args.lowPriority;
        if (args.lowPriority) targetRoom.is_favourite = false;
        pushRoomListUpdate();
      }
      return undefined;
    },
    set_room_muted: (args) => {
      const targetRoom = findRoom(args.roomId as string);
      if (targetRoom) {
        targetRoom.is_muted = args.muted;
        targetRoom.notification_mode = args.muted ? "mute" : "all_messages";
        pushRoomListUpdate();
      }
      return undefined;
    },
    set_room_marked_unread: (args) => {
      const targetRoom = findRoom(args.roomId as string);
      if (targetRoom) {
        targetRoom.is_marked_unread = args.unread;
        targetRoom.has_unread =
          Boolean(args.unread) ||
          (!targetRoom.is_muted && (targetRoom.unread_messages as number) > 0) ||
          (targetRoom.unread_count as number) > 0;
        pushRoomListUpdate();
      }
      return undefined;
    },
    set_room_manual_order: (args) => {
      const targetRoom = findRoom(args.roomId as string);
      if (targetRoom) {
        targetRoom.manual_order = args.order;
        pushRoomListUpdate();
      }
      return undefined;
    },
    list_space_children: (args) => spaceChildren.get(args.spaceId as string) ?? [],
    join_room: () => undefined,
    knock_room: () => undefined,

    // Spec 08: account/devices/notifications settings commands.
    logout: () => undefined,
    get_profile: () => profile,
    set_display_name: (args) => {
      profile = { ...profile, display_name: args.displayName as string | null };
      return undefined;
    },
    list_devices: () =>
      devices.map((d) => ({
        ...d,
        last_seen_ip: null,
        last_seen_ts: null,
        is_current: d.device_id === seed.deviceId,
      })),
    delete_device: (args) => {
      const index = devices.findIndex((d) => d.device_id === args.deviceId);
      if (index !== -1) devices.splice(index, 1);
      return undefined;
    },
    // Skips the real Rust command's "wait for the other device to accept"
    // step — this fake has no second device to accept anything, so it emits
    // `verification:request` for the target device right away, same shape
    // `VerificationOverlay` already expects from an incoming request.
    request_device_verification: (args) => {
      const deviceId = args.deviceId as string;
      const flowId = `flow-${deviceId}`;
      emit("verification:request", {
        flow_id: flowId,
        other_user_id: seed.userId,
        other_device_id: deviceId,
      });
      return flowId;
    },
    get_cross_signing_reset_url: () => null,
    cross_signing_status: () => ({
      has_master_key: crossSigningBootstrapped,
      has_self_signing_key: crossSigningBootstrapped,
      has_user_signing_key: crossSigningBootstrapped,
    }),
    bootstrap_cross_signing: () => {
      crossSigningBootstrapped = true;
      return undefined;
    },
    get_notification_settings: () => ({ ...notificationSettings }),
    set_default_notification_mode: (args) => {
      notificationSettings.default_mode = args.mode as string;
      return undefined;
    },
    add_notification_keyword: (args) => {
      notificationSettings.keywords.push(args.keyword as string);
      return undefined;
    },
    remove_notification_keyword: (args) => {
      notificationSettings.keywords = notificationSettings.keywords.filter(
        (k) => k !== args.keyword,
      );
      return undefined;
    },
    set_global_mute: (args) => {
      notificationSettings.global_mute = args.muted as boolean;
      return undefined;
    },
    set_sound_enabled: (args) => {
      notificationSettings.sound_enabled = args.enabled as boolean;
      return undefined;
    },

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
        sender_display_name: null,
        sender_avatar_url: null,
        sender_avatar_path: null,
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
        ? {
            event_id: target.event_id,
            sender: target.sender,
            sender_display_name: target.sender_display_name ?? null,
            preview: target.body,
          }
        : null;
      const pending = {
        event_id: transactionId,
        sender: seed.userId,
        sender_display_name: null,
        sender_avatar_url: null,
        sender_avatar_path: null,
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
      // Spec 02: `@tauri-apps/plugin-dialog`'s `open()` goes through this
      // same IPC layer rather than a separate mock — `ChatShell`'s attach
      // button calls it directly, so media-attachments.spec.ts drives the
      // "user picked a file" step by seeding `filePickerResult`.
      if (cmd === "plugin:dialog|open") {
        return Promise.resolve(seed.filePickerResult ?? null);
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
