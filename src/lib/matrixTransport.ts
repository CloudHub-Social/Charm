import { listen as tauriListen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  IPC_OPERATION_ID_HEADER,
  invoke as tauriInvoke,
  type InvokeOptions,
} from "@/observability/ipc";
import { createIpcOperationId } from "@/observability/operationId";
import { isWebBuild } from "./platform";

type InvokeArgs = Record<string, unknown>;
type EventCallback<T> = (event: { payload: T }) => void;

type ServerEvent = {
  event: string;
  data: unknown;
};

const webEventListeners = new Map<string, Set<EventCallback<unknown>>>();
let webSocket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let reconnectAttempt = 0;

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export type { UnlistenFn };

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

class WebCommandError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

async function readErrorResponse(response: Response, fallback: string): Promise<Error> {
  const text = await response.text();
  if (text) {
    try {
      const body = JSON.parse(text) as unknown;
      if (isRecord(body)) {
        if (typeof body.kind === "string") {
          const message =
            typeof body.message === "string"
              ? body.message
              : typeof body.error === "string"
                ? body.error
                : body.kind;
          return new WebCommandError(body.kind, message);
        }
        if (typeof body.error === "string") return new HttpError(body.error, response.status);
        if (typeof body.message === "string") return new HttpError(body.message, response.status);
      }
    } catch {
      return new HttpError(text, response.status);
    }
    return new HttpError(text, response.status);
  }
  return new HttpError(fallback, response.status);
}

function shouldUseWebTransport(): boolean {
  return isWebBuild();
}

function apiBase(): string {
  const configured = import.meta.env.VITE_CHARM_WEB_API_BASE_URL;
  return configured?.replace(/\/+$/, "") ?? "";
}

function websocketUrl(): string {
  const base = apiBase();
  const path = "/api/ws";
  if (!base) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${path}`;
  }
  const url = new URL(`${base}${path}`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function jsonHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    [IPC_OPERATION_ID_HEADER]: createIpcOperationId(),
  };
}

function unsupported(command: string): never {
  throw new WebCommandError(
    "UnsupportedCommand",
    `The web companion transport does not support '${command}' yet.`,
  );
}

function invalidCommandArgs(command: string, message: string): never {
  throw new WebCommandError("InvalidCommandArgs", `${command}: ${message}`);
}

function onboardingStorageKey(userId: unknown): string | null {
  if (typeof userId === "string" && userId.length > 0) {
    return `charm:onboarding-complete:${userId}`;
  }
  return null;
}

function dispatchWebEvent(event: string, payload: unknown): void {
  const listeners = webEventListeners.get(event);
  if (!listeners) return;
  for (const callback of listeners) {
    try {
      callback({ payload });
    } catch (err) {
      console.error(err);
    }
  }
}

function handleWebSocketMessage(socket: WebSocket, raw: MessageEvent<unknown>): void {
  if (webSocket !== socket) return;
  if (typeof raw.data !== "string") return;
  let parsed: ServerEvent;
  try {
    const candidate = JSON.parse(raw.data) as Partial<ServerEvent>;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      typeof candidate.event !== "string" ||
      !("data" in candidate)
    ) {
      return;
    }
    parsed = { event: candidate.event, data: candidate.data };
  } catch {
    return;
  }
  dispatchWebEvent(parsed.event, parsed.data);
  if (
    parsed.event === "verification:sas_update" &&
    parsed.data &&
    typeof parsed.data === "object" &&
    "flow_id" in parsed.data
  ) {
    dispatchWebEvent(`verification:sas_update:${String(parsed.data.flow_id)}`, parsed.data);
  }
}

function scheduleWebSocketReconnect(): void {
  if (reconnectTimer !== null || webEventListeners.size === 0) return;
  const delay = Math.min(
    INITIAL_RECONNECT_DELAY_MS * 2 ** reconnectAttempt,
    MAX_RECONNECT_DELAY_MS,
  );
  reconnectAttempt += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    ensureWebSocket();
  }, delay);
}

function ensureWebSocket(): void {
  if (
    webSocket &&
    (webSocket.readyState === WebSocket.CONNECTING || webSocket.readyState === WebSocket.OPEN)
  ) {
    return;
  }
  const socket = new WebSocket(websocketUrl());
  webSocket = socket;
  socket.addEventListener("message", (event) => handleWebSocketMessage(socket, event));
  socket.addEventListener("open", () => {
    if (webSocket === socket) reconnectAttempt = 0;
  });
  socket.addEventListener("close", () => {
    if (webSocket !== socket) return;
    webSocket = null;
    scheduleWebSocketReconnect();
  });
  socket.addEventListener("error", () => {
    if (webSocket === socket) socket.close();
  });
}

async function requestJson<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const options: RequestInit = {
    method,
    credentials: "include",
    headers:
      body === undefined ? { [IPC_OPERATION_ID_HEADER]: createIpcOperationId() } : jsonHeaders(),
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${apiBase()}${path}`, options);
  if (!response.ok) {
    throw await readErrorResponse(response, `${method} ${path} failed with ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function requestBytes<T>(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: BodyInit,
  contentType?: string,
): Promise<T> {
  const headers: Record<string, string> = { [IPC_OPERATION_ID_HEADER]: createIpcOperationId() };
  if (contentType) headers["content-type"] = contentType;
  const response = await fetch(`${apiBase()}${path}`, {
    method,
    credentials: "include",
    headers,
    body,
  });
  if (!response.ok) {
    throw await readErrorResponse(response, `${method} ${path} failed with ${response.status}`);
  }
  return undefined as T;
}

function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && typeof value !== "undefined") search.set(key, String(value));
  }
  const value = search.toString();
  return value ? `?${value}` : "";
}

function maybeFile(value: unknown): File | null {
  return typeof File !== "undefined" && value instanceof File ? value : null;
}

function requireWebFile(command: string, value: unknown): File {
  const file = maybeFile(value);
  if (file) return file;
  throw new Error(`The web companion transport requires a browser File for '${command}'.`);
}

async function invokeWeb<T>(command: string, args: InvokeArgs = {}): Promise<T> {
  switch (command) {
    case "discover_homeserver":
      return requestJson<T>("POST", "/api/auth/discover", args.input);
    case "login":
      return requestJson<T>("POST", "/api/auth/login", args.request);
    case "register":
      return requestJson<T>("POST", "/api/auth/register", args.request);
    case "try_restore_session":
      return requestJson<T>("GET", "/api/auth/me").catch((error: unknown) => {
        if (error instanceof HttpError && (error.status === 401 || error.status === 400)) {
          return null as T;
        }
        throw error;
      });
    case "logout":
      return requestJson<T>("POST", "/api/auth/logout");
    case "list_rooms":
      return requestJson<T>("GET", "/api/rooms");
    case "accept_invite":
      return requestJson<T>(
        "POST",
        `/api/rooms/${encodeSegment(String(args.roomId))}/invite/accept`,
      );
    case "decline_invite":
      return requestJson<T>(
        "POST",
        `/api/rooms/${encodeSegment(String(args.roomId))}/invite/decline`,
      );
    case "resolve_room_alias":
      return requestJson<T>("POST", "/api/rooms/resolve-alias", args.alias);
    case "get_room_details":
      return requestJson<T>("GET", `/api/rooms/${encodeSegment(String(args.roomId))}`);
    case "get_room_members":
      return requestJson<T>("GET", `/api/rooms/${encodeSegment(String(args.roomId))}/members`);
    case "get_room_member_list":
      return requestJson<T>("GET", `/api/rooms/${encodeSegment(String(args.roomId))}/member-list`);
    case "get_timeline_page":
      return requestJson<T>(
        "GET",
        `/api/rooms/${encodeSegment(String(args.roomId))}/timeline${query({
          limit: args.limit as number | undefined,
        })}`,
      );
    case "list_space_hierarchy":
      return requestJson<T>("GET", `/api/rooms/${encodeSegment(String(args.spaceId))}/hierarchy`);
    case "join_room":
      return requestJson<T>("POST", "/api/rooms/join", {
        room_id_or_alias: args.roomIdOrAlias,
      });
    case "knock_room":
      return requestJson<T>("POST", "/api/rooms/knock", {
        room_id_or_alias: args.roomIdOrAlias,
        reason: args.reason,
      });
    case "create_space":
      return requestJson<T>("POST", "/api/rooms/create-space", {
        name: args.name,
        topic: args.topic,
        room_alias_name: args.roomAliasName,
        public: args.public,
      });
    case "send_message":
      return requestJson<T>("POST", `/api/rooms/${encodeSegment(String(args.roomId))}/send`, {
        body: args.body,
        formatted_body: args.formattedBody,
        mentions: args.mentions,
      });
    case "send_reply":
      return requestJson<T>("POST", `/api/rooms/${encodeSegment(String(args.roomId))}/reply`, {
        in_reply_to_event_id: args.inReplyToEventId,
        body: args.body,
      });
    case "edit_message":
      return requestJson<T>(
        "POST",
        `/api/rooms/${encodeSegment(String(args.roomId))}/events/${encodeSegment(
          String(args.eventId),
        )}/edit`,
        { new_body: args.newBody },
      );
    case "redact_event":
      return requestBytes<T>(
        "POST",
        `/api/rooms/${encodeSegment(String(args.roomId))}/events/${encodeSegment(
          String(args.eventId),
        )}/redact`,
        JSON.stringify({ reason: args.reason }),
        "application/json",
      );
    case "resend_message":
      return requestJson<T>(
        "POST",
        `/api/rooms/${encodeSegment(String(args.roomId))}/send-queue/${encodeSegment(
          String(args.transactionId),
        )}/resend`,
      );
    case "discard_failed_message":
      return requestJson<T>(
        "POST",
        `/api/rooms/${encodeSegment(String(args.roomId))}/send-queue/${encodeSegment(
          String(args.transactionId),
        )}/discard`,
      );
    case "can_redact":
      return requestJson<T>(
        "GET",
        `/api/rooms/${encodeSegment(String(args.roomId))}/can-redact${query({
          target_sender: args.targetSender as string,
        })}`,
      );
    case "can_redact_others":
      return requestJson<T>(
        "GET",
        `/api/rooms/${encodeSegment(String(args.roomId))}/can-redact-others`,
      );
    case "toggle_reaction":
      return requestJson<T>(
        "POST",
        `/api/rooms/${encodeSegment(String(args.roomId))}/events/${encodeSegment(
          String(args.targetEventId),
        )}/react`,
        { key: args.key },
      );
    case "run_command":
      return requestJson<T>("POST", `/api/rooms/${encodeSegment(String(args.roomId))}/command`, {
        command: args.command,
        args: args.args,
      });
    case "send_read_receipt":
      return requestJson<T>("POST", `/api/rooms/${encodeSegment(String(args.roomId))}/receipt`, {
        event_id: args.eventId,
        private: args.private,
      });
    case "send_typing":
      return requestJson<T>("POST", `/api/rooms/${encodeSegment(String(args.roomId))}/typing`, {
        typing: args.typing,
      });
    case "mark_room_read":
      return requestJson<T>("POST", `/api/rooms/${encodeSegment(String(args.roomId))}/mark-read`);
    case "set_room_favourite":
      return requestJson<T>(
        "PUT",
        `/api/rooms/${encodeSegment(String(args.roomId))}/favourite`,
        args.favourite,
      );
    case "set_room_low_priority":
      return requestJson<T>(
        "PUT",
        `/api/rooms/${encodeSegment(String(args.roomId))}/low-priority`,
        args.lowPriority,
      );
    case "set_room_marked_unread":
      return requestJson<T>(
        "PUT",
        `/api/rooms/${encodeSegment(String(args.roomId))}/marked-unread`,
        args.unread,
      );
    case "set_room_manual_order":
      return requestJson<T>(
        "PUT",
        `/api/rooms/${encodeSegment(String(args.roomId))}/manual-order`,
        args.order,
      );
    case "set_room_name":
      return requestJson<T>(
        "PUT",
        `/api/rooms/${encodeSegment(String(args.roomId))}/name`,
        args.name,
      );
    case "set_room_topic":
      return requestJson<T>(
        "PUT",
        `/api/rooms/${encodeSegment(String(args.roomId))}/topic`,
        args.topic,
      );
    case "remove_room_avatar":
      return requestJson<T>("DELETE", `/api/rooms/${encodeSegment(String(args.roomId))}/avatar`);
    case "get_room_local_aliases":
      return requestJson<T>("GET", `/api/rooms/${encodeSegment(String(args.roomId))}/aliases`);
    case "check_room_alias_available":
      return requestJson<T>("POST", "/api/rooms/aliases/check-availability", args.alias);
    case "add_room_alias":
      return requestJson<T>(
        "PUT",
        `/api/rooms/${encodeSegment(String(args.roomId))}/aliases`,
        args.alias,
      );
    case "remove_room_alias":
      return requestJson<T>("DELETE", `/api/rooms/aliases/${encodeSegment(String(args.alias))}`);
    case "set_canonical_alias":
      return requestJson<T>(
        "PUT",
        `/api/rooms/${encodeSegment(String(args.roomId))}/canonical-alias`,
        args.alias,
      );
    case "remove_alt_alias":
      return requestJson<T>(
        "DELETE",
        `/api/rooms/${encodeSegment(String(args.roomId))}/alt-aliases/${encodeSegment(String(args.alias))}`,
      );
    case "set_room_join_rule":
      return requestJson<T>(
        "PUT",
        `/api/rooms/${encodeSegment(String(args.roomId))}/join-rule`,
        args.joinRule,
      );
    case "set_room_history_visibility":
      return requestJson<T>(
        "PUT",
        `/api/rooms/${encodeSegment(String(args.roomId))}/history-visibility`,
        args.visibility,
      );
    case "enable_room_encryption":
      return requestJson<T>("POST", `/api/rooms/${encodeSegment(String(args.roomId))}/encryption`);
    case "set_room_power_level_thresholds":
      return requestJson<T>(
        "PUT",
        `/api/rooms/${encodeSegment(String(args.roomId))}/power-levels/thresholds`,
        args.changes,
      );
    case "set_member_power_level":
      return requestJson<T>(
        "PUT",
        `/api/rooms/${encodeSegment(String(args.roomId))}/members/${encodeSegment(
          String(args.userId),
        )}/power-level`,
        args.powerLevel,
      );
    case "invite_member":
      return requestJson<T>(
        "POST",
        `/api/rooms/${encodeSegment(String(args.roomId))}/members/${encodeSegment(
          String(args.userId),
        )}/invite`,
      );
    case "kick_member":
    case "ban_member":
    case "unban_member": {
      const action = command.replace("_member", "");
      return requestBytes<T>(
        "POST",
        `/api/rooms/${encodeSegment(String(args.roomId))}/members/${encodeSegment(
          String(args.userId),
        )}/${action}`,
        JSON.stringify({ reason: args.reason }),
        "application/json",
      );
    }
    case "set_presence":
      return requestJson<T>("PUT", "/api/presence", {
        presence: args.presence,
        status_msg: args.statusMsg,
      });
    case "get_presence":
      return requestJson<T>("GET", `/api/presence/${encodeSegment(String(args.userId))}`);
    case "get_own_profile":
      return requestJson<T>("GET", "/api/profile/me");
    case "get_profile": {
      const profile = await requestJson<{
        user_id: string;
        display_name: string | null;
        avatar_url: string | null;
        uses_oauth: boolean;
      }>("GET", "/api/profile/me");
      return profile as T;
    }
    case "set_display_name":
      return requestJson<T>("PUT", "/api/profile/display-name", args.displayName);
    case "get_account_deactivate_url":
      return requestJson<T>("GET", "/api/account/deactivate-url");
    case "get_account_data":
      return requestJson<T>("GET", `/api/account-data/${encodeSegment(String(args.eventType))}`);
    case "set_account_data":
      return requestJson<T>(
        "PUT",
        `/api/account-data/${encodeSegment(String(args.eventType))}`,
        args.content,
      );
    case "get_local_onboarding_flag": {
      const key = onboardingStorageKey(args.userId);
      return (key ? localStorage.getItem(key) === "true" : false) as T;
    }
    case "set_local_onboarding_flag": {
      const key = onboardingStorageKey(args.userId);
      if (key) localStorage.setItem(key, "true");
      return undefined as T;
    }
    case "resolve_media":
      return `${apiBase()}/api/rooms/${encodeSegment(String(args.roomId))}/events/${encodeSegment(
        String(args.eventId),
      )}/media${query({ thumbnail: args.thumbnail as boolean })}` as T;
    case "resolve_avatar":
      return `${apiBase()}/api/media/avatar${query({ mxc: args.mxcUrl as string })}` as T;
    // Spec 29: proxies to the companion server's `/api/media/preview_url`,
    // which wraps the same shared `get_url_preview_impl` desktop's Tauri
    // command uses. `roomId` isn't sent — the route (like the desktop
    // command) doesn't use it either, it's only accepted for IPC-contract
    // parity in case a room-scoped policy is added later.
    // Resolve to `null` ("no preview available") on any failure (404,
    // network error, timeout, etc.) rather than throwing — matching the
    // Rust command's own contract that a missing/unavailable preview is
    // never a hard error. The `link_previews` feature flag already keeps
    // this off by default.
    case "get_url_preview":
      return requestJson<T>("POST", "/api/media/preview_url", {
        url: args.url as string,
        event_ts_ms: (args.eventTsMs as number | null | undefined) ?? undefined,
      }).catch(() => null as T);
    case "send_attachment": {
      const file = requireWebFile(command, args.filePath);
      const form = new FormData();
      form.set("file", file);
      if (typeof args.caption === "string") form.set("caption", args.caption);
      return requestBytes<T>(
        "POST",
        `/api/rooms/${encodeSegment(String(args.roomId))}/attachments${query({
          txn_id: args.txnId as string,
        })}`,
        form,
      );
    }
    case "set_avatar":
    case "set_room_avatar": {
      const file = maybeFile(args.filePath);
      if (!file) invalidCommandArgs(command, "requires a browser File for 'filePath'");
      const path =
        command === "set_avatar"
          ? "/api/profile/avatar"
          : `/api/rooms/${encodeSegment(String(args.roomId))}/avatar`;
      return requestBytes<T>("PUT", path, file, file.type || "application/octet-stream");
    }
    case "remove_avatar":
      return requestJson<T>("DELETE", "/api/profile/avatar");
    case "bootstrap_cross_signing":
      return requestBytes<T>(
        "POST",
        "/api/verification/cross-signing",
        JSON.stringify({ password: args.password }),
        "application/json",
      );
    case "cross_signing_status":
      return requestJson<T>("GET", "/api/verification/cross-signing");
    case "get_cross_signing_reset_url":
      return requestJson<T>("GET", "/api/verification/cross-signing/reset-url");
    case "recovery_status":
      return requestJson<T>("GET", "/api/verification/recovery");
    case "recover_from_key":
      return requestJson<T>("POST", "/api/verification/recovery", {
        recovery_key: args.recoveryKey,
      });
    case "list_devices":
      return requestJson<T>("GET", "/api/devices");
    case "delete_device":
      return requestJson<T>("DELETE", `/api/devices/${encodeSegment(String(args.deviceId))}`, {
        password: args.password,
      });
    case "get_device_delete_url":
      return requestJson<T>(
        "GET",
        `/api/devices/${encodeSegment(String(args.deviceId))}/delete-url`,
      );
    case "accept_verification_request":
    case "cancel_verification":
    case "start_sas_verification":
    case "confirm_sas_verification": {
      const action = {
        accept_verification_request: "accept",
        cancel_verification: "cancel",
        start_sas_verification: "sas/start",
        confirm_sas_verification: "sas/confirm",
      }[command];
      return requestJson<T>(
        "POST",
        `/api/verification/${encodeSegment(String(args.otherUserId))}/${encodeSegment(
          String(args.flowId),
        )}/${action}`,
      );
    }
    case "request_device_verification":
      return requestJson<T>(
        "POST",
        `/api/verification/devices/${encodeSegment(String(args.deviceId))}/request`,
      );
    case "is_desktop_platform":
    case "get_autostart":
      return false as T;
    case "set_autostart":
    case "set_focused_room":
    case "set_badge_count":
      return undefined as T;
    default:
      return unsupported(command);
  }
}

export async function invoke<T>(
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  if (!shouldUseWebTransport()) return tauriInvoke<T>(command, args, options);
  // invokeWeb has no breadcrumb/capture logic of its own (unlike the Tauri
  // path's observability/ipc wrapper), so options like skipBreadcrumb and
  // captureOnError have nothing to do here — but a caller's
  // onFailureBreadcrumb (e.g. lib/matrix.ts's invokeMatrix) still needs
  // calling on failure, or it silently never fires on the web build.
  const startedAt = performance.now();
  try {
    return await invokeWeb<T>(command, args ?? {});
  } catch (error) {
    options?.onFailureBreadcrumb?.(error, Math.round(performance.now() - startedAt));
    throw error;
  }
}

export async function listen<T>(event: string, callback: EventCallback<T>): Promise<UnlistenFn> {
  if (!shouldUseWebTransport()) return tauriListen<T>(event, callback);
  const listeners = webEventListeners.get(event) ?? new Set<EventCallback<unknown>>();
  listeners.add(callback as EventCallback<unknown>);
  webEventListeners.set(event, listeners);
  ensureWebSocket();
  return () => {
    listeners.delete(callback as EventCallback<unknown>);
    if (listeners.size === 0) webEventListeners.delete(event);
    if (webEventListeners.size === 0) {
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      reconnectAttempt = 0;
      webSocket?.close();
      webSocket = null;
    }
  };
}
