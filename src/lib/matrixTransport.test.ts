import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_OPERATION_ID_HEADER } from "@/observability/ipc";
import { invoke, listen } from "./matrixTransport";

type FetchCall = [string, RequestInit];

class MockWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readonly url: string;
  readyState = MockWebSocket.OPEN;

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  emit(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  emitRaw(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  static instances: MockWebSocket[] = [];
}

function fetchMock() {
  return vi.mocked(fetch);
}

function lastFetch(): FetchCall {
  return fetchMock().mock.calls.at(-1) as FetchCall;
}

function okJson(value: unknown = null): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("matrix web transport", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.stubEnv("VITE_CHARM_BUILD_TARGET", "web");
    vi.stubEnv("VITE_CHARM_WEB_API_BASE_URL", "https://api.example");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ ok: true })));
    vi.stubGlobal("WebSocket", MockWebSocket);
    MockWebSocket.instances = [];
    localStorage.clear();
  });

  it.each([
    ["discover_homeserver", { input: "matrix.org" }, "POST", "/api/auth/discover", "matrix.org"],
    [
      "login",
      { request: { homeserver_url: "http://localhost:8010", username: "alice", password: "pw" } },
      "POST",
      "/api/auth/login",
      { homeserver_url: "http://localhost:8010", username: "alice", password: "pw" },
    ],
    ["list_rooms", {}, "GET", "/api/rooms", undefined],
    ["try_restore_session", {}, "GET", "/api/auth/me", undefined],
    [
      "resolve_room_alias",
      { alias: "#room:example.org" },
      "POST",
      "/api/rooms/resolve-alias",
      "#room:example.org",
    ],
    [
      "get_room_details",
      { roomId: "!r:example.org" },
      "GET",
      "/api/rooms/!r%3Aexample.org",
      undefined,
    ],
    [
      "get_room_members",
      { roomId: "!r:example.org" },
      "GET",
      "/api/rooms/!r%3Aexample.org/members",
      undefined,
    ],
    [
      "get_room_member_list",
      { roomId: "!r:example.org" },
      "GET",
      "/api/rooms/!r%3Aexample.org/member-list",
      undefined,
    ],
    [
      "get_timeline_page",
      { roomId: "!r:example.org", limit: 50 },
      "GET",
      "/api/rooms/!r%3Aexample.org/timeline?limit=50",
      undefined,
    ],
    [
      "list_space_hierarchy",
      { spaceId: "!space:example.org" },
      "GET",
      "/api/rooms/!space%3Aexample.org/hierarchy",
      undefined,
    ],
    [
      "join_room",
      { roomIdOrAlias: "#space-room:example.org" },
      "POST",
      "/api/rooms/join",
      { room_id_or_alias: "#space-room:example.org" },
    ],
    [
      "knock_room",
      { roomIdOrAlias: "!knock:example.org", reason: "please" },
      "POST",
      "/api/rooms/knock",
      { room_id_or_alias: "!knock:example.org", reason: "please" },
    ],
    [
      "send_message",
      { roomId: "!r:example.org", body: "hi", formattedBody: null, mentions: null },
      "POST",
      "/api/rooms/!r%3Aexample.org/send",
      { body: "hi", formatted_body: null, mentions: null },
    ],
    [
      "send_reply",
      { roomId: "!r:example.org", inReplyToEventId: "$e", body: "reply" },
      "POST",
      "/api/rooms/!r%3Aexample.org/reply",
      { in_reply_to_event_id: "$e", body: "reply" },
    ],
    [
      "edit_message",
      { roomId: "!r:example.org", eventId: "$e", newBody: "edited" },
      "POST",
      "/api/rooms/!r%3Aexample.org/events/%24e/edit",
      { new_body: "edited" },
    ],
    [
      "can_redact",
      { roomId: "!r:example.org", targetSender: "@alice:example.org" },
      "GET",
      "/api/rooms/!r%3Aexample.org/can-redact?target_sender=%40alice%3Aexample.org",
      undefined,
    ],
    [
      "toggle_reaction",
      { roomId: "!r:example.org", targetEventId: "$e", key: "👍" },
      "POST",
      "/api/rooms/!r%3Aexample.org/events/%24e/react",
      { key: "👍" },
    ],
    [
      "run_command",
      { roomId: "!r:example.org", command: "join", args: ["#room:example.org"] },
      "POST",
      "/api/rooms/!r%3Aexample.org/command",
      { command: "join", args: ["#room:example.org"] },
    ],
    [
      "send_read_receipt",
      { roomId: "!r:example.org", eventId: "$e", private: true },
      "POST",
      "/api/rooms/!r%3Aexample.org/receipt",
      { event_id: "$e", private: true },
    ],
    [
      "send_typing",
      { roomId: "!r:example.org", typing: true },
      "POST",
      "/api/rooms/!r%3Aexample.org/typing",
      { typing: true },
    ],
    [
      "mark_room_read",
      { roomId: "!r:example.org" },
      "POST",
      "/api/rooms/!r%3Aexample.org/mark-read",
      undefined,
    ],
    [
      "set_room_favourite",
      { roomId: "!r:example.org", favourite: true },
      "PUT",
      "/api/rooms/!r%3Aexample.org/favourite",
      true,
    ],
    [
      "set_room_low_priority",
      { roomId: "!r:example.org", lowPriority: true },
      "PUT",
      "/api/rooms/!r%3Aexample.org/low-priority",
      true,
    ],
    [
      "set_room_marked_unread",
      { roomId: "!r:example.org", unread: true },
      "PUT",
      "/api/rooms/!r%3Aexample.org/marked-unread",
      true,
    ],
    [
      "set_room_manual_order",
      { roomId: "!r:example.org", order: 1.5 },
      "PUT",
      "/api/rooms/!r%3Aexample.org/manual-order",
      1.5,
    ],
    [
      "set_room_name",
      { roomId: "!r:example.org", name: "Room" },
      "PUT",
      "/api/rooms/!r%3Aexample.org/name",
      "Room",
    ],
    [
      "set_room_topic",
      { roomId: "!r:example.org", topic: "Topic" },
      "PUT",
      "/api/rooms/!r%3Aexample.org/topic",
      "Topic",
    ],
    [
      "remove_room_avatar",
      { roomId: "!r:example.org" },
      "DELETE",
      "/api/rooms/!r%3Aexample.org/avatar",
      undefined,
    ],
    [
      "set_room_join_rule",
      { roomId: "!r:example.org", joinRule: "invite" },
      "PUT",
      "/api/rooms/!r%3Aexample.org/join-rule",
      "invite",
    ],
    [
      "set_room_history_visibility",
      { roomId: "!r:example.org", visibility: "joined" },
      "PUT",
      "/api/rooms/!r%3Aexample.org/history-visibility",
      "joined",
    ],
    [
      "enable_room_encryption",
      { roomId: "!r:example.org" },
      "POST",
      "/api/rooms/!r%3Aexample.org/encryption",
      undefined,
    ],
    [
      "set_presence",
      { presence: "unavailable", statusMsg: "away" },
      "PUT",
      "/api/presence",
      { presence: "unavailable", status_msg: "away" },
    ],
    [
      "get_presence",
      { userId: "@alice:example.org" },
      "GET",
      "/api/presence/%40alice%3Aexample.org",
      undefined,
    ],
    ["get_own_profile", {}, "GET", "/api/profile/me", undefined],
    ["set_display_name", { displayName: "Alice" }, "PUT", "/api/profile/display-name", "Alice"],
    [
      "get_account_data",
      { eventType: "social.cloudhub.charm.onboarding" },
      "GET",
      "/api/account-data/social.cloudhub.charm.onboarding",
      undefined,
    ],
    [
      "set_account_data",
      { eventType: "social.cloudhub.charm.onboarding", content: { complete: true } },
      "PUT",
      "/api/account-data/social.cloudhub.charm.onboarding",
      { complete: true },
    ],
    [
      "set_room_power_level_thresholds",
      { roomId: "!r:example.org", changes: { invite: 50 } },
      "PUT",
      "/api/rooms/!r%3Aexample.org/power-levels/thresholds",
      { invite: 50 },
    ],
    [
      "set_member_power_level",
      { roomId: "!r:example.org", userId: "@alice:example.org", powerLevel: 50 },
      "PUT",
      "/api/rooms/!r%3Aexample.org/members/%40alice%3Aexample.org/power-level",
      50,
    ],
    [
      "invite_member",
      { roomId: "!r:example.org", userId: "@alice:example.org" },
      "POST",
      "/api/rooms/!r%3Aexample.org/members/%40alice%3Aexample.org/invite",
      undefined,
    ],
    [
      "kick_member",
      { roomId: "!r:example.org", userId: "@alice:example.org", reason: "bye" },
      "POST",
      "/api/rooms/!r%3Aexample.org/members/%40alice%3Aexample.org/kick",
      { reason: "bye" },
    ],
    [
      "ban_member",
      { roomId: "!r:example.org", userId: "@alice:example.org", reason: "spam" },
      "POST",
      "/api/rooms/!r%3Aexample.org/members/%40alice%3Aexample.org/ban",
      { reason: "spam" },
    ],
    [
      "unban_member",
      { roomId: "!r:example.org", userId: "@alice:example.org" },
      "POST",
      "/api/rooms/!r%3Aexample.org/members/%40alice%3Aexample.org/unban",
      {},
    ],
    ["remove_avatar", {}, "DELETE", "/api/profile/avatar", undefined],
    [
      "bootstrap_cross_signing",
      { password: "pw" },
      "POST",
      "/api/verification/cross-signing",
      { password: "pw" },
    ],
    ["cross_signing_status", {}, "GET", "/api/verification/cross-signing", undefined],
    [
      "get_cross_signing_reset_url",
      {},
      "GET",
      "/api/verification/cross-signing/reset-url",
      undefined,
    ],
    ["list_devices", {}, "GET", "/api/devices", undefined],
    [
      "delete_device",
      { deviceId: "DEVICE", password: "pw" },
      "DELETE",
      "/api/devices/DEVICE",
      { password: "pw" },
    ],
    [
      "get_device_delete_url",
      { deviceId: "DEVICE" },
      "GET",
      "/api/devices/DEVICE/delete-url",
      undefined,
    ],
    [
      "accept_verification_request",
      { otherUserId: "@alice:example.org", flowId: "flow" },
      "POST",
      "/api/verification/%40alice%3Aexample.org/flow/accept",
      undefined,
    ],
    [
      "cancel_verification",
      { otherUserId: "@alice:example.org", flowId: "flow" },
      "POST",
      "/api/verification/%40alice%3Aexample.org/flow/cancel",
      undefined,
    ],
    [
      "start_sas_verification",
      { otherUserId: "@alice:example.org", flowId: "flow" },
      "POST",
      "/api/verification/%40alice%3Aexample.org/flow/sas/start",
      undefined,
    ],
    [
      "confirm_sas_verification",
      { otherUserId: "@alice:example.org", flowId: "flow" },
      "POST",
      "/api/verification/%40alice%3Aexample.org/flow/sas/confirm",
      undefined,
    ],
    [
      "request_device_verification",
      { deviceId: "DEVICE" },
      "POST",
      "/api/verification/devices/DEVICE/request",
      undefined,
    ],
  ])("maps %s to the companion server route", async (command, args, method, path, body) => {
    await invoke(command, args);

    const [url, init] = lastFetch();
    expect(url).toBe(`https://api.example${path}`);
    expect(init.method).toBe(method);
    expect(init.credentials).toBe("include");
    expect(new Headers(init.headers).get(IPC_OPERATION_ID_HEADER)).toMatch(/^ipc-/);
    if (body === undefined) {
      expect(init.body).toBeUndefined();
    } else {
      expect(typeof init.body).toBe("string");
      expect(JSON.parse(init.body as string)).toEqual(body);
    }
  });

  it("returns API URLs for media without fetching bytes eagerly", async () => {
    const media = await invoke<string>("resolve_media", {
      roomId: "!r:example.org",
      eventId: "$event",
      thumbnail: true,
    });
    const avatar = await invoke<string>("resolve_avatar", { mxcUrl: "mxc://example.org/a" });

    expect(media).toBe(
      "https://api.example/api/rooms/!r%3Aexample.org/events/%24event/media?thumbnail=true",
    );
    expect(avatar).toBe("https://api.example/api/media/avatar?mxc=mxc%3A%2F%2Fexample.org%2Fa");
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("uses same-origin HTTP and WebSocket routes when no API base URL is configured", async () => {
    vi.stubEnv("VITE_CHARM_WEB_API_BASE_URL", "");
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: "https://preview.example/",
        protocol: "https:",
        host: "preview.example",
      },
    });

    await invoke("list_rooms");
    const unlisten = await listen("room_list:update", vi.fn());

    expect(lastFetch()[0]).toBe("/api/rooms");
    expect(MockWebSocket.instances[0]?.url).toBe("wss://preview.example/api/ws");

    unlisten();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("preserves path prefixes in configured WebSocket API base URLs", async () => {
    vi.stubEnv("VITE_CHARM_WEB_API_BASE_URL", "https://example.com/charm///");

    const unlisten = await listen("room_list:update", vi.fn());

    expect(MockWebSocket.instances[0]?.url).toBe("wss://example.com/charm/api/ws");

    unlisten();
  });

  it("uses browser File bodies for web uploads", async () => {
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });

    await invoke("set_avatar", { filePath: file });
    await invoke("set_room_avatar", { roomId: "!r:example.org", filePath: file });
    await invoke("send_attachment", { roomId: "!r:example.org", filePath: file, txnId: "txn1" });

    const calls = fetchMock().mock.calls as FetchCall[];
    expect(calls[0][1].body).toBe(file);
    expect(calls[1][0]).toBe("https://api.example/api/rooms/!r%3Aexample.org/avatar");
    expect(calls[2][0]).toBe(
      "https://api.example/api/rooms/!r%3Aexample.org/attachments?txn_id=txn1",
    );
    expect(calls[2][1].body).toBeInstanceOf(FormData);
  });

  it("preserves OAuth session metadata from the web profile endpoint", async () => {
    fetchMock().mockResolvedValueOnce(
      okJson({
        user_id: "@alice:example.org",
        display_name: "Alice",
        avatar_url: "mxc://example.org/avatar",
        avatar_path: null,
        presence: "online",
        uses_oauth: true,
      }),
    );

    await expect(invoke("get_profile")).resolves.toMatchObject({
      user_id: "@alice:example.org",
      uses_oauth: true,
    });
  });

  it("stores the local onboarding flag in browser storage", async () => {
    await expect(
      invoke("get_local_onboarding_flag", { userId: "@alice:example.org" }),
    ).resolves.toBe(false);
    await invoke("set_local_onboarding_flag", { userId: "@alice:example.org" });
    await expect(
      invoke("get_local_onboarding_flag", { userId: "@alice:example.org" }),
    ).resolves.toBe(true);
    await expect(invoke("get_local_onboarding_flag", { userId: "@bob:example.org" })).resolves.toBe(
      false,
    );
  });

  it("fetches account deactivation links from the web companion", async () => {
    fetchMock().mockResolvedValueOnce(new Response(JSON.stringify("https://idp.example/account")));

    await expect(invoke("get_account_deactivate_url")).resolves.toBe("https://idp.example/account");
    expect(fetchMock()).toHaveBeenCalledWith(
      "https://api.example/api/account/deactivate-url",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns web-safe values for shell-only no-op commands", async () => {
    await expect(invoke("is_desktop_platform")).resolves.toBe(false);
    await expect(invoke("get_autostart")).resolves.toBe(false);
    await expect(invoke("set_focused_room", { roomId: "!r" })).resolves.toBeUndefined();
    await expect(invoke("set_badge_count", { count: 3 })).resolves.toBeUndefined();
  });

  it("rejects commands and uploads that the web transport cannot support yet", async () => {
    await expect(
      invoke("start_qr_login", { homeserverUrl: "https://example.org" }),
    ).rejects.toMatchObject({
      kind: "UnsupportedCommand",
      message: "The web companion transport does not support 'start_qr_login' yet.",
    });
    await expect(
      invoke("send_attachment", {
        roomId: "!r:example.org",
        filePath: "/tmp/file.png",
        txnId: "t",
      }),
    ).rejects.toThrow("requires a browser File for 'send_attachment'");
    await expect(invoke("set_avatar", { filePath: "/tmp/file.png" })).rejects.toMatchObject({
      kind: "InvalidCommandArgs",
      message: "set_avatar: requires a browser File for 'filePath'",
    });
  });

  it("surfaces HTTP error response text", async () => {
    fetchMock().mockResolvedValueOnce(new Response("bad login", { status: 401 }));

    await expect(invoke("login", { request: {} })).rejects.toThrow("bad login");
  });

  it("calls onFailureBreadcrumb on the web transport's failure path too", async () => {
    fetchMock().mockResolvedValueOnce(new Response("bad login", { status: 401 }));
    const onFailureBreadcrumb = vi.fn();

    await expect(invoke("login", { request: {} }, { onFailureBreadcrumb })).rejects.toThrow(
      "bad login",
    );

    expect(onFailureBreadcrumb).toHaveBeenCalledWith(expect.any(Error), expect.any(Number));
  });

  it("surfaces JSON error response messages", async () => {
    fetchMock().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "bad login" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(invoke("login", { request: {} })).rejects.toThrow("bad login");
  });

  it("preserves structured UIA errors from the web companion", async () => {
    fetchMock().mockResolvedValueOnce(
      new Response(JSON.stringify({ kind: "UiaChallenge", error: "UIA challenge required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(invoke("bootstrap_cross_signing")).rejects.toMatchObject({
      kind: "UiaChallenge",
    });
  });

  it("treats a 401 restore response as no browser session", async () => {
    fetchMock().mockResolvedValueOnce(new Response("no session", { status: 401 }));

    await expect(invoke("try_restore_session")).resolves.toBeNull();
  });

  it("treats a malformed restore response as no browser session", async () => {
    fetchMock().mockResolvedValueOnce(new Response("session has no device id", { status: 400 }));

    await expect(invoke("try_restore_session")).resolves.toBeNull();
  });

  it("dispatches multiplexed WebSocket events to matching listeners", async () => {
    const roomList = vi.fn();
    const sasUpdate = vi.fn();

    const unlistenRoomList = await listen("room_list:update", roomList);
    const unlistenSas = await listen("verification:sas_update:flow1", sasUpdate);
    const socket = MockWebSocket.instances[0];

    expect(socket?.url).toBe("wss://api.example/api/ws");
    socket?.emit({ event: "room_list:update", data: [{ room_id: "!r" }] });
    socket?.emit({
      event: "verification:sas_update",
      data: { flow_id: "flow1", state: "started" },
    });

    expect(roomList).toHaveBeenCalledWith({ payload: [{ room_id: "!r" }] });
    expect(sasUpdate).toHaveBeenCalledWith({ payload: { flow_id: "flow1", state: "started" } });

    unlistenRoomList();
    unlistenSas();
  });

  it("keeps dispatching WebSocket events when one listener throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const throwingSasUpdate = vi.fn(() => {
      throw new Error("listener failed");
    });
    const sasUpdate = vi.fn();

    const unlistenThrowing = await listen("verification:sas_update", throwingSasUpdate);
    const unlistenSas = await listen("verification:sas_update:flow1", sasUpdate);
    const socket = MockWebSocket.instances[0];

    socket?.emit({
      event: "verification:sas_update",
      data: { flow_id: "flow1", state: "started" },
    });

    expect(throwingSasUpdate).toHaveBeenCalledWith({
      payload: { flow_id: "flow1", state: "started" },
    });
    expect(sasUpdate).toHaveBeenCalledWith({ payload: { flow_id: "flow1", state: "started" } });
    expect(consoleError).toHaveBeenCalledWith(expect.any(Error));

    unlistenThrowing();
    unlistenSas();
  });

  it("ignores stale WebSocket close and error events after reconnecting", async () => {
    const roomList = vi.fn();

    const unlistenRoomList = await listen("room_list:update", roomList);
    const staleSocket = MockWebSocket.instances[0];
    staleSocket.readyState = MockWebSocket.CLOSED;
    const unlistenTimeline = await listen("timeline:update", vi.fn());
    const currentSocket = MockWebSocket.instances[1];

    staleSocket.dispatchEvent(new Event("error"));
    staleSocket.dispatchEvent(new Event("close"));
    currentSocket.emit({ event: "room_list:update", data: [{ room_id: "!r" }] });

    expect(currentSocket.readyState).toBe(MockWebSocket.OPEN);
    expect(roomList).toHaveBeenCalledWith({ payload: [{ room_id: "!r" }] });

    unlistenRoomList();
    unlistenTimeline();
  });

  it("ignores stale WebSocket messages after reconnecting", async () => {
    const roomList = vi.fn();

    const unlistenRoomList = await listen("room_list:update", roomList);
    const staleSocket = MockWebSocket.instances[0];
    staleSocket.readyState = MockWebSocket.CLOSED;
    const unlistenTimeline = await listen("timeline:update", vi.fn());
    const currentSocket = MockWebSocket.instances[1];

    staleSocket.emit({ event: "room_list:update", data: [{ room_id: "!stale" }] });
    currentSocket.emit({ event: "room_list:update", data: [{ room_id: "!current" }] });

    expect(roomList).toHaveBeenCalledTimes(1);
    expect(roomList).toHaveBeenCalledWith({ payload: [{ room_id: "!current" }] });

    unlistenRoomList();
    unlistenTimeline();
  });

  it("backs off WebSocket reconnect attempts while listeners remain active", async () => {
    vi.useFakeTimers();
    const unlisten = await listen("room_list:update", vi.fn());
    const firstSocket = MockWebSocket.instances[0];

    firstSocket.close();
    await vi.advanceTimersByTimeAsync(999);
    expect(MockWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    const secondSocket = MockWebSocket.instances[1];
    secondSocket.close();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(MockWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    unlisten();
  });

  it("resets WebSocket reconnect backoff after a successful connection", async () => {
    vi.useFakeTimers();
    const unlisten = await listen("room_list:update", vi.fn());
    const firstSocket = MockWebSocket.instances[0];

    firstSocket.close();
    await vi.advanceTimersByTimeAsync(1_000);
    const secondSocket = MockWebSocket.instances[1];
    secondSocket.dispatchEvent(new Event("open"));
    secondSocket.close();

    await vi.advanceTimersByTimeAsync(999);
    expect(MockWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    unlisten();
  });

  it("ignores malformed WebSocket frames", async () => {
    const roomList = vi.fn();

    const unlisten = await listen("room_list:update", roomList);
    const socket = MockWebSocket.instances[0];

    expect(() => socket.emitRaw("not json")).not.toThrow();
    expect(() => socket.emitRaw(new Blob(["{}"]))).not.toThrow();
    socket.emit({ event: 123, data: [] });
    socket.emit({ event: "room_list:update" });

    expect(roomList).not.toHaveBeenCalled();

    unlisten();
  });
});
