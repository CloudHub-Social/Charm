import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Hand-authored mirror of src-tauri/src/matrix/mod.rs types.
 * Regenerate via `cargo test` (ts-rs export) once a Phase 1 build step wires
 * this up automatically; keep in sync manually until then.
 */
export interface LoginRequest {
  homeserver_url: string;
  username: string;
  password: string;
}

export interface LoginResponse {
  user_id: string;
  device_id: string;
}

export type SyncStateEvent =
  | { status: "syncing" }
  | { status: "idle" }
  | { status: "error"; message: string };

export interface RoomSummary {
  room_id: string;
  name: string | null;
  unread_count: number;
}

export function login(request: LoginRequest): Promise<LoginResponse> {
  return invoke("login", { request });
}

export function tryRestoreSession(): Promise<LoginResponse | null> {
  return invoke("try_restore_session");
}

export function listRooms(): Promise<RoomSummary[]> {
  return invoke("list_rooms");
}

export function resolveRoomAlias(alias: string): Promise<string> {
  return invoke("resolve_room_alias", { alias });
}

export function onSyncState(callback: (event: SyncStateEvent) => void): Promise<UnlistenFn> {
  return listen<SyncStateEvent>("sync:state", (e) => callback(e.payload));
}

export function onRoomListUpdate(callback: (rooms: RoomSummary[]) => void): Promise<UnlistenFn> {
  return listen<RoomSummary[]>("room_list:update", (e) => callback(e.payload));
}

export interface RoomMessageSummary {
  event_id: string;
  sender: string;
  body: string;
  timestamp_ms: number;
}

export interface TimelinePage {
  messages: RoomMessageSummary[];
  next_cursor: string | null;
}

export function getTimelinePage(
  roomId: string,
  cursor?: string,
  limit?: number,
): Promise<TimelinePage> {
  return invoke("get_timeline_page", { roomId, cursor, limit });
}

export function sendMessage(roomId: string, body: string): Promise<void> {
  return invoke("send_message", { roomId, body });
}

export interface RoomTimelineUpdate {
  room_id: string;
  messages: RoomMessageSummary[];
}

export function onTimelineUpdate(
  callback: (update: RoomTimelineUpdate) => void,
): Promise<UnlistenFn> {
  return listen<RoomTimelineUpdate>("timeline:update", (e) => callback(e.payload));
}

export interface VerificationRequestSummary {
  flow_id: string;
  other_user_id: string;
  other_device_id: string;
}

export interface EmojiPair {
  symbol: string;
  description: string;
}

export type SasUpdateEvent =
  | { state: "started" }
  | { state: "accepted" }
  | { state: "keys_exchanged"; emojis: EmojiPair[] }
  | { state: "confirmed" }
  | { state: "done" }
  | { state: "cancelled"; reason: string };

export interface CrossSigningStatusSummary {
  has_master_key: boolean;
  has_self_signing_key: boolean;
  has_user_signing_key: boolean;
}

export function bootstrapCrossSigning(password?: string): Promise<void> {
  return invoke("bootstrap_cross_signing", { password });
}

export function crossSigningStatus(): Promise<CrossSigningStatusSummary> {
  return invoke("cross_signing_status");
}

export function acceptVerificationRequest(otherUserId: string, flowId: string): Promise<void> {
  return invoke("accept_verification_request", { otherUserId, flowId });
}

export function cancelVerification(otherUserId: string, flowId: string): Promise<void> {
  return invoke("cancel_verification", { otherUserId, flowId });
}

export function startSasVerification(otherUserId: string, flowId: string): Promise<void> {
  return invoke("start_sas_verification", { otherUserId, flowId });
}

export function confirmSasVerification(otherUserId: string, flowId: string): Promise<void> {
  return invoke("confirm_sas_verification", { otherUserId, flowId });
}

export function onVerificationRequest(
  callback: (request: VerificationRequestSummary) => void,
): Promise<UnlistenFn> {
  return listen<VerificationRequestSummary>("verification:request", (e) => callback(e.payload));
}

export function onSasUpdate(
  flowId: string,
  callback: (update: SasUpdateEvent) => void,
): Promise<UnlistenFn> {
  return listen<SasUpdateEvent>(`verification:sas_update:${flowId}`, (e) => callback(e.payload));
}
