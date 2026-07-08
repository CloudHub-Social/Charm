import { listen as tauriListen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { invoke as tauriInvoke } from "@/observability/ipc";
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
let fallbackOperationCounter = 0;

export type { UnlistenFn };

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function shouldUseWebTransport(): boolean {
  return isWebBuild();
}

function apiBase(): string {
  const configured = import.meta.env.VITE_CHARM_WEB_API_BASE_URL;
  return configured?.replace(/\/$/, "") ?? "";
}

function websocketUrl(): string {
  const base = apiBase();
  const path = "/api/ws";
  if (!base) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${path}`;
  }
  const url = new URL(path, `${base}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function operationId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `ipc-${globalThis.crypto.randomUUID()}`;
  }
  fallbackOperationCounter += 1;
  return `ipc-${Date.now().toString(36)}-${fallbackOperationCounter.toString(36)}`;
}

function jsonHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
    "x-charm-operation-id": operationId(),
  };
}

function unsupported(command: string): never {
  throw new Error(`The web companion transport does not support '${command}' yet.`);
}

function dispatchWebEvent(event: string, payload: unknown): void {
  webEventListeners.get(event)?.forEach((callback) => callback({ payload }));
}

function handleWebSocketMessage(raw: MessageEvent<unknown>): void {
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
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    ensureWebSocket();
  }, 1_000);
}

function ensureWebSocket(): void {
  if (
    webSocket &&
    (webSocket.readyState === WebSocket.CONNECTING || webSocket.readyState === WebSocket.OPEN)
  ) {
    return;
  }
  webSocket = new WebSocket(websocketUrl());
  webSocket.addEventListener("message", handleWebSocketMessage);
  webSocket.addEventListener("close", () => {
    webSocket = null;
    scheduleWebSocketReconnect();
  });
  webSocket.addEventListener("error", () => {
    webSocket?.close();
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
    headers: body === undefined ? { "x-charm-operation-id": operationId() } : jsonHeaders(),
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${apiBase()}${path}`, options);
  if (!response.ok) {
    const message = await response.text();
    throw new HttpError(
      message || `${method} ${path} failed with ${response.status}`,
      response.status,
    );
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
  const headers: HeadersInit = { "x-charm-operation-id": operationId() };
  if (contentType) headers["content-type"] = contentType;
  const response = await fetch(`${apiBase()}${path}`, {
    method,
    credentials: "include",
    headers,
    body,
  });
  if (!response.ok) {
    const message = await response.text();
    throw new HttpError(
      message || `${method} ${path} failed with ${response.status}`,
      response.status,
    );
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
        if (error instanceof HttpError && error.status === 401) return null as T;
        throw error;
      });
    case "logout":
      return requestJson<T>("POST", "/api/auth/logout");
    case "list_rooms":
      return requestJson<T>("GET", "/api/rooms");
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
    case "can_redact":
      return requestJson<T>(
        "GET",
        `/api/rooms/${encodeSegment(String(args.roomId))}/can-redact${query({
          target_sender: args.targetSender as string,
        })}`,
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
      }>("GET", "/api/profile/me");
      return { ...profile, uses_oauth: false } as T;
    }
    case "get_account_data":
      return requestJson<T>("GET", `/api/account-data/${encodeSegment(String(args.eventType))}`);
    case "set_account_data":
      return requestJson<T>(
        "PUT",
        `/api/account-data/${encodeSegment(String(args.eventType))}`,
        args.content,
      );
    case "get_local_onboarding_flag":
      return (localStorage.getItem("charm:onboarding-complete") === "true") as T;
    case "set_local_onboarding_flag":
      localStorage.setItem("charm:onboarding-complete", "true");
      return undefined as T;
    case "resolve_media":
      return `${apiBase()}/api/rooms/${encodeSegment(String(args.roomId))}/events/${encodeSegment(
        String(args.eventId),
      )}/media${query({ thumbnail: args.thumbnail as boolean })}` as T;
    case "resolve_avatar":
      return `${apiBase()}/api/media/avatar${query({ mxc: args.mxcUrl as string })}` as T;
    case "send_attachment": {
      const file = maybeFile(args.filePath);
      if (!file) unsupported(command);
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
      if (!file) unsupported(command);
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

export async function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
  if (!shouldUseWebTransport()) return tauriInvoke<T>(command, args);
  return invokeWeb<T>(command, args);
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
      webSocket?.close();
      webSocket = null;
    }
  };
}
