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
    __e2eEmit: (event: string, payload: unknown) => void;
  }
}

export function installMockTauri(seed: {
  userId: string;
  deviceId: string;
  room: { room_id: string; name: string | null; unread_count: number };
  members?: { user_id: string; display_name: string | null }[];
  otherDevices?: { device_id: string; display_name: string | null; is_verified: boolean }[];
  ignoredUsers?: string[];
  roomDetails?: Record<string, unknown>;
  /** Messages present when the room first opens, for composed timeline states. */
  initialMessages?: Record<string, unknown>[];
  /** Deterministic homeserver URL previews, keyed by the original URL. */
  urlPreviews?: Record<string, Record<string, unknown>>;
  /** Server-published aliases returned by `get_room_local_aliases`. */
  roomAliases?: string[];
  /** Initial native Do Not Disturb state for Focus-mode journeys. */
  dndState?: { enabled: boolean; until: number | null; revision: number };
  /**
   * Spec 12: bookmarks already saved before the page loads, in the shape
   * `list_bookmarks` returns (see `src-tauri/src/matrix/bookmarks.rs`'s
   * `BookmarkEntry`) — drives the Saved Messages settings panel journey.
   */
  bookmarks?: {
    room_id: string;
    event_id: string;
    saved_at_ms: number;
    sender: string;
    sender_display_name: string | null;
    body_preview: string;
    timestamp_ms: number;
  }[];
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
  /** `list_space_hierarchy` results, keyed by the root space's `room_id`. */
  spaceHierarchy?: Record<string, Record<string, unknown>[]>;
  /**
   * Initial `recovery_status` state — defaults to `"enabled"` so every other
   * spec's Devices panel never shows the recovery-key prompt. Set to
   * `"incomplete"` to drive settings.spec.ts's recovery-restore flow.
   */
  recoveryState?: "unknown" | "enabled" | "disabled" | "incomplete";
  /**
   * `had_unclean_previous_session`'s response — defaults to `false`/unset so
   * every other spec never sees `main.tsx`'s `CrashRecoveryPrompt`. Set to
   * `true` to drive crash-recovery.spec.ts's prompt flow.
   */
  previousSessionCrashed?: boolean;
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
    membership: "join",
    inviter_user_id: null,
    inviter_display_name: null,
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
    membership: "join",
    inviter_user_id: null,
    inviter_display_name: null,
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
  const spaceHierarchy = new Map(Object.entries(seed.spaceHierarchy ?? {}));
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
  window.__e2eEmit = emit;

  let nextTxnId = 1;
  let nextEventId = 1;
  let nextCreatedRoomId = 1;
  const messagesByRoom = new Map<string, Record<string, unknown>[]>();
  for (const r of allRooms) {
    messagesByRoom.set(r.room_id as string, []);
  }
  messagesByRoom.set(room.room_id, [...(seed.initialMessages ?? [])]);
  const roomAliases = [...(seed.roomAliases ?? [])];

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
  let recoveryState = seed.recoveryState ?? "enabled";
  let autostartEnabled = false;
  const hasSeededDndState = seed.dndState != null;
  let dndState = seed.dndState ?? { enabled: false, until: null as number | null, revision: 0 };
  const ignoredUsers: string[] = [...(seed.ignoredUsers ?? [])];
  const bookmarks: NonNullable<typeof seed.bookmarks> = [...(seed.bookmarks ?? [])];
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
      set_canonical_alias: true,
    },
    canonical_alias: null,
    alt_aliases: [],
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
    // Shallow-copies every room, not just `[...allRooms]` (a fresh array of
    // the *same* room object references): the real backend always sends a
    // freshly-deserialized `RoomSummary` for every room on every snapshot,
    // even ones nothing changed about — see `roomListItemPropsEqual`'s doc
    // comment in `RoomListItem.tsx`. This mock used to mutate a room's
    // fields in place (`set_room_muted`/`set_room_marked_unread`/etc. below)
    // and re-emit the *same* object reference, which that comparator's
    // `a === b` reference-equality fast path treats as "definitely
    // unchanged" — before this fix, a genuinely mutated room reached
    // `RoomListItem` and had the memo skip its re-render entirely, an
    // E2E-mock-only bug (not reachable with the real backend's always-fresh
    // objects) that a real caller mutating in place would trigger for real.
    emit(
      "room_list:update",
      allRooms.map((r) => ({ ...r })),
    );
  }

  // Spec 05: read receipts, typing, presence. Deliberately not modeling a
  // second real user session — these commands just accept the send and
  // clear the room's unread state; `__e2eEmit` is how a test simulates the
  // *incoming* side (another user's receipt/typing/presence) since there's
  // no second client in this fake to produce it organically.

  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    try_restore_session: () => ({ user_id: seed.userId, device_id: seed.deviceId }),
    // Shallow-copied for the same reason `pushRoomListUpdate` below is: the
    // real backend never hands out a live, mutable reference the frontend
    // could still see updates to via a later in-place mutation elsewhere in
    // this mock (`set_room_muted` et al., via `findRoom`) — returning
    // `allRooms` directly here made React's *very first* committed `room`
    // props literally the same objects `set_room_muted` mutates later, so
    // even a memo comparator that only compares fresh emissions correctly
    // (`pushRoomListUpdate`'s fix) still saw a corrupted "previous" snapshot
    // that had silently caught up to the "next" one without a render ever
    // happening — the root cause of a room's list-row indicators (mute,
    // marked-unread, rename) failing to update. `list_rooms` runs once at
    // mount, so this copy isn't behind a hot path.
    list_rooms: () => (seed.hasRooms === false ? [] : allRooms.map((r) => ({ ...r }))),
    // Spec 12: bookmarks. Real `list_bookmarks` re-sorts newest-saved-first
    // and resolves a live preview when the room's timeline is open; this
    // fake just returns the seeded (or since-added) entries sorted the same
    // way — no separate resolution step, since the fake never persists a
    // resolved-vs-placeholder distinction the way the real command does.
    list_bookmarks: () => bookmarks.toSorted((a, b) => b.saved_at_ms - a.saved_at_ms),
    add_bookmark: (args) => {
      const roomId = args.roomId as string;
      const eventId = args.eventId as string;
      if (bookmarks.some((b) => b.event_id === eventId)) return null;
      const message = (seed.initialMessages ?? []).find((m) => m.event_id === eventId);
      bookmarks.push({
        room_id: roomId,
        event_id: eventId,
        saved_at_ms: Date.now(),
        sender: (message?.sender as string) ?? "",
        sender_display_name: (message?.sender_display_name as string | null) ?? null,
        body_preview: (message?.body as string) ?? "",
        timestamp_ms: (message?.timestamp_ms as number) ?? Date.now(),
      });
      return null;
    },
    remove_bookmark: (args) => {
      const eventId = args.eventId as string;
      const index = bookmarks.findIndex((b) => b.event_id === eventId);
      if (index >= 0) bookmarks.splice(index, 1);
      return null;
    },
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
    // A fresh array copy, not `messagesByRoom.get(...)` directly — same
    // footgun `pushTimelineUpdate` above already guards against: that array
    // is mutated in place by later handlers (e.g. replacing a pending echo
    // with its sent counterpart by index), and the frontend keeps its own
    // reference to whatever this returns to compare a *later* snapshot
    // against. Handing back the live, still-mutating array means that
    // comparison sees the *current* (already-mutated) content instead of
    // the content as of this call, silently matching the real IPC layer's
    // behavior of always deserializing a genuinely new array over the wire.
    get_timeline_page: (args) => ({
      messages: [...(messagesByRoom.get(args.roomId as string) ?? [])],
      next_cursor: null,
    }),
    // Mirrors the real `mark_room_read` Rust command, which only sends a read
    // receipt + fully-read marker — it does NOT touch the separate MSC2867
    // `m.marked_unread` flag (that's `set_room_marked_unread`'s job). So this
    // clears the numeric unread counters but leaves `is_marked_unread` alone.
    // With both counters now zeroed, the `has_unread` invariant's other two
    // clauses (`unread_messages > 0`, `unread_count > 0`) are unconditionally
    // false, so the recompute reduces to just `is_marked_unread` — computing
    // the full invariant here would wrongly read the counters *after*
    // they'd already been cleared.
    mark_room_read: (args) => {
      const targetRoom = findRoom(args.roomId as string);
      if (targetRoom) {
        targetRoom.unread_count = 0;
        targetRoom.unread_messages = 0;
        targetRoom.has_unread = Boolean(targetRoom.is_marked_unread);
        pushRoomListUpdate();
      }
      return undefined;
    },
    send_typing: () => undefined,
    can_redact: () => true,
    get_room_members: () => seed.members ?? [],
    run_command: () => ({ status: "success" }),
    // main.tsx's crash-recovery nudge — see `previousSessionCrashed` above.
    had_unclean_previous_session: () => Boolean(seed.previousSessionCrashed),

    // Spec 02: media and attachments.
    send_attachment: async (args) => {
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
      // events (see `UploadProgress`'s doc comment). The `setTimeout` between
      // them is deliberate: without it, both events fire synchronously within
      // this one command invocation and React batches add -> partial ->
      // remove before ever painting, so a test could never observe the
      // in-flight state (and a regression that stopped rendering the upload
      // row entirely would still pass).
      emit("upload:progress", { txn_id: txnId, room_id: roomId, sent: 50, total: 100 });
      await new Promise((resolve) => setTimeout(resolve, 100));
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
    get_url_preview: (args) => seed.urlPreviews?.[args.url as string] ?? null,

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
    list_space_hierarchy: (args) => spaceHierarchy.get(args.spaceId as string) ?? [],
    // Spec 19 Phase 4: create/join-by-address. Mirrors the real Rust
    // commands' contract closely enough to exercise `CreateJoinSpaceDialog`
    // end to end — `create_space` returns the new room's id and adds it to
    // the live room list (like a real `m.room.create` would surface via the
    // next sync), and `join_room` resolves an alias to a synthetic room id
    // rather than actually contacting a homeserver.
    create_space: (args) => {
      const roomId = `!created-space-${nextCreatedRoomId++}:e2e`;
      allRooms.push({
        ...defaultRoomShape,
        room_id: roomId,
        name: args.name,
        is_space: true,
      });
      messagesByRoom.set(roomId, []);
      pushRoomListUpdate();
      return roomId;
    },
    join_room: (args) => {
      const target = args.roomIdOrAlias as string;
      const existing = findRoom(target);
      if (existing) return { room_id: existing.room_id, is_space: existing.is_space };
      const roomId = target.startsWith("!") ? target : `!resolved-${nextCreatedRoomId++}:e2e`;
      allRooms.push({
        ...defaultRoomShape,
        room_id: roomId,
        name: target,
        is_space: true,
      });
      messagesByRoom.set(roomId, []);
      pushRoomListUpdate();
      return { room_id: roomId, is_space: true };
    },
    accept_invite: (args) => {
      const target = findRoom(args.roomId as string);
      if (!target || target.membership !== "invite") throw new Error("invite not found");
      target.membership = "join";
      target.inviter_user_id = null;
      target.inviter_display_name = null;
      pushRoomListUpdate();
      return undefined;
    },
    decline_invite: (args) => {
      const index = allRooms.findIndex((candidate) => candidate.room_id === args.roomId);
      if (index === -1 || allRooms[index]?.membership !== "invite") {
        throw new Error("invite not found");
      }
      allRooms.splice(index, 1);
      pushRoomListUpdate();
      return undefined;
    },
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
    recovery_status: () => recoveryState,
    // Real matrix-sdk recovery has no fixed "the" correct key to check
    // against — this fake just needs a way to distinguish success from
    // failure, so "correct-key" always succeeds and anything else simulates
    // a wrong recovery key the same way a real invalid one would surface.
    recover_from_key: (args) => {
      if (args.recoveryKey !== "correct-key") {
        throw new Error("invalid recovery key");
      }
      recoveryState = "enabled";
      crossSigningBootstrapped = true;
      return undefined;
    },
    get_3pids: () => [],
    get_ignored_users: () => [...ignoredUsers],
    ignore_user: (args) => {
      const userId = args.userId as string;
      if (!ignoredUsers.includes(userId)) ignoredUsers.push(userId);
      return undefined;
    },
    unignore_user: (args) => {
      const index = ignoredUsers.indexOf(args.userId as string);
      if (index !== -1) ignoredUsers.splice(index, 1);
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

    // Spec 10: native platform shell. No real tray/dock/taskbar to drive in
    // e2e, so these just track enough in-memory state for the settings
    // toggles/focus-tracking effects to round-trip.
    set_focused_room: () => undefined,
    set_badge_count: () => undefined,
    get_autostart: () => autostartEnabled,
    set_autostart: (args) => {
      autostartEnabled = args.enabled as boolean;
      return undefined;
    },
    // Preserve the historical unresolved/no-op behavior for specs that do
    // not exercise Focus mode; a seeded journey opts into the full state.
    get_dnd_state: () => (hasSeededDndState ? { ...dndState } : undefined),
    set_dnd_state: (args) => {
      dndState = {
        enabled: args.enabled as boolean,
        until: args.until as number | null,
        revision: dndState.revision + 1,
      };
      emit("dnd:changed", { ...dndState });
      return { ...dndState };
    },

    get_room_details: () => ({ ...roomDetails }),
    get_room_member_list: () => [...memberList],
    get_room_local_aliases: () => [...roomAliases],
    check_room_alias_available: (args) => !roomAliases.includes(args.alias as string),
    add_room_alias: (args) => {
      const alias = args.alias as string;
      if (!roomAliases.includes(alias)) roomAliases.push(alias);
      return undefined;
    },
    remove_room_alias: (args) => {
      const index = roomAliases.indexOf(args.alias as string);
      if (index !== -1) roomAliases.splice(index, 1);
      return undefined;
    },
    set_canonical_alias: (args) => {
      roomDetails.canonical_alias = args.alias;
      pushRoomDetailsUpdate();
      return undefined;
    },
    remove_alt_alias: (args) => {
      roomDetails.alt_aliases = (roomDetails.alt_aliases as string[]).filter(
        (alias) => alias !== args.alias,
      );
      pushRoomDetailsUpdate();
      return undefined;
    },
    set_room_name: (args) => {
      roomDetails.name = args.name;
      room.name = args.name as string | null;
      pushRoomDetailsUpdate();
      // Real sync also re-snapshots the room list on any state change —
      // the chat header and `RoomList` both read the room's name from
      // `RoomSummary`, not `RoomDetails`, so this keeps them in sync too
      // (see Spec 07 acceptance criteria 2).
      pushRoomListUpdate();
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
        // Stashed (not part of the real RoomMessageSummary shape) so
        // `get_edit_history` below can still show the pre-edit body after
        // this in-place mutation — a real edit is a separate `m.replace`
        // event, but this mock keeps one message object per row.
        if (!message.originalBody) message.originalBody = message.body;
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

    // Spec 37 (message action parity, remaining slices): report/view-source/
    // edit-history/reaction-details/forward. Kept intentionally minimal —
    // just enough shape for the frontend dialogs to render real data, not a
    // faithful re-implementation of the Rust relation-walking these back.

    report_event: () => undefined,

    get_event_source: (args) => {
      const roomId = args.roomId as string;
      const eventId = args.eventId as string;
      const message = findMessage(roomId, eventId);
      return JSON.stringify(
        {
          type: "m.room.message",
          event_id: eventId,
          sender: message?.sender ?? seed.userId,
          room_id: roomId,
          origin_server_ts: message?.timestamp_ms ?? Date.now(),
          content: { msgtype: "m.text", body: message?.body ?? "" },
        },
        null,
        2,
      );
    },

    get_edit_history: (args) => {
      const roomId = args.roomId as string;
      const eventId = args.eventId as string;
      const message = findMessage(roomId, eventId);
      if (!message) return [];
      const original = {
        event_id: eventId,
        body: (message.originalBody as string | undefined) ?? (message.body as string),
        formatted_body: null,
        sender: message.sender,
        origin_server_ts: message.timestamp_ms,
      };
      if (!message.edited) return [original];
      return [
        original,
        {
          event_id: `${eventId}-edit-1`,
          body: message.body,
          formatted_body: null,
          sender: message.sender,
          origin_server_ts: Date.now(),
        },
      ];
    },

    get_reaction_details: (args) => {
      const roomId = args.roomId as string;
      const message = findMessage(roomId, args.targetEventId as string);
      const key = args.key as string;
      const reactions = (message?.reactions ?? []) as {
        key: string;
        count: number;
        reacted_by_me: boolean;
      }[];
      const reaction = reactions.find((r) => r.key === key);
      if (!reaction) return [];
      const otherSenders = (seed.members ?? []).map((m) => m.user_id);
      const senders = [seed.userId, ...otherSenders].slice(0, Math.max(reaction.count, 1));
      return senders.map((sender, index) => ({
        sender,
        origin_server_ts: Date.now() - index * 1000,
      }));
    },

    forward_message: (args) => {
      const targetRoomId = args.targetRoomId as string;
      const eventId = args.eventId as string;
      const sourceRoomId = args.sourceRoomId as string;
      const source = findMessage(sourceRoomId, eventId);
      const transactionId = `txn-${nextTxnId++}`;
      const forwarded = {
        event_id: `\$${nextEventId++}`,
        sender: seed.userId,
        sender_display_name: null,
        sender_avatar_url: null,
        sender_avatar_path: null,
        body: source?.body ?? "",
        formatted_body: null,
        timestamp_ms: Date.now(),
        edited: false,
        redacted: false,
        reactions: [],
        in_reply_to: null,
        transaction_id: transactionId,
        send_state: { state: "sent" },
      };
      messagesByRoom.get(targetRoomId)?.push(forwarded);
      pushTimelineUpdate(targetRoomId);
      return transactionId;
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
