import type { BadgeState } from "@bindings/BadgeState";
import type { CommandResult } from "@bindings/CommandResult";
import type { CrossSigningStatusSummary } from "@bindings/CrossSigningStatusSummary";
import type { DeviceSummary } from "@bindings/DeviceSummary";
import type { DiscoverHomeserverResponse } from "@bindings/DiscoverHomeserverResponse";
import type { EmojiPair } from "@bindings/EmojiPair";
import type { EventReceipt } from "@bindings/EventReceipt";
import type { HistoryVisibilityKind } from "@bindings/HistoryVisibilityKind";
import type { JoinedRoom } from "@bindings/JoinedRoom";
import type { JoinRuleKind } from "@bindings/JoinRuleKind";
import type { LoginRequest } from "@bindings/LoginRequest";
import type { LoginResponse } from "@bindings/LoginResponse";
import type { MediaContent } from "@bindings/MediaContent";
import type { MembershipKind } from "@bindings/MembershipKind";
import type { NotificationSettingsSummary } from "@bindings/NotificationSettingsSummary";
import type { OwnProfile } from "@bindings/OwnProfile";
import type { PowerLevelThresholds } from "@bindings/PowerLevelThresholds";
import type { PresenceStateDto } from "@bindings/PresenceStateDto";
import type { PresenceUpdate } from "@bindings/PresenceUpdate";
import type { ProfileSummary } from "@bindings/ProfileSummary";
import type { ThirdPartyIdSummary } from "@bindings/ThirdPartyIdSummary";
import type { PusherKind } from "@bindings/PusherKind";
import type { PushRegistration } from "@bindings/PushRegistration";
import type { PushStatus } from "@bindings/PushStatus";
import type { QrLoginProgressEvent } from "@bindings/QrLoginProgressEvent";
import type { ReactionGroup } from "@bindings/ReactionGroup";
import type { ReactionToggleResult } from "@bindings/ReactionToggleResult";
import type { ReceiptTypeDto } from "@bindings/ReceiptTypeDto";
import type { ReceiptUpdate } from "@bindings/ReceiptUpdate";
import type { RecoveryStatusSummary } from "@bindings/RecoveryStatusSummary";
import type { RegisterRequest } from "@bindings/RegisterRequest";
import type { ReplyRef } from "@bindings/ReplyRef";
import type { RoomDetails } from "@bindings/RoomDetails";
import type { RoomMemberSummary } from "@bindings/RoomMemberSummary";
import type { RoomMessageSummary } from "@bindings/RoomMessageSummary";
import type { RoomMembershipKind } from "@bindings/RoomMembershipKind";
import type { RoomNotificationModeKind } from "@bindings/RoomNotificationModeKind";
import type { RoomPermissions } from "@bindings/RoomPermissions";
import type { RoomSummary } from "@bindings/RoomSummary";
import type { RoomTimelineUpdate } from "@bindings/RoomTimelineUpdate";
import type { SasUpdateEvent } from "@bindings/SasUpdateEvent";
import type { SelfProfileUpdate } from "@bindings/SelfProfileUpdate";
import type { SendState } from "@bindings/SendState";
import type { SlashCommand } from "@bindings/SlashCommand";
import type { SpaceBadgeState } from "@bindings/SpaceBadgeState";
import type { SpaceChild } from "@bindings/SpaceChild";
import type { SpaceHierarchyNode } from "@bindings/SpaceHierarchyNode";
import type { SpaceJoinRule } from "@bindings/SpaceJoinRule";
import type { SyncStateEvent } from "@bindings/SyncStateEvent";
import type { TimelinePage } from "@bindings/TimelinePage";
import type { TypingUpdate } from "@bindings/TypingUpdate";
import type { UploadProgress } from "@bindings/UploadProgress";
import type { VerificationRequestSummary } from "@bindings/VerificationRequestSummary";
import * as Sentry from "@sentry/react";
import type { InvokeOptions } from "@/observability/ipc";
import { summarizeValue } from "@/observability/scrubbers";
import { invoke, listen, type UnlistenFn } from "./matrixTransport";
import { isWebBuild } from "./platform";

function addMatrixIpcBreadcrumb(
  level: "info" | "error",
  message: string,
  data: Record<string, unknown>,
): void {
  const client = Sentry.getClient();
  if (!client?.getOptions().enabled) return;
  Sentry.addBreadcrumb({ category: "matrix.ipc", level, message, data });
}

/**
 * Calls a Matrix IPC command (routed through matrixTransport, so it works on
 * both the Tauri desktop build and the web build) and adds a Matrix-aware
 * Sentry breadcrumb with args/result/error run through `summarizeValue` —
 * the same length-only/redacted-shape summarization `observability/ipc.ts`
 * uses, rather than a denylist of known free-text field names, since Matrix
 * commands keep growing new ones (captions, statuses, reasons, display
 * names, local file paths, colonless `$eventId`s, ...) that a denylist can
 * never fully enumerate. Passes `skipBreadcrumb: true` and
 * `onFailureBreadcrumb` through to matrixTransport's underlying
 * observability/ipc wrapper on the desktop build so a command doesn't get
 * both its generic `tauri.ipc` breadcrumbs and this function's `matrix.ipc`
 * one, and so the `matrix.ipc` failure breadcrumb is recorded before (not
 * after) `captureOnError`'s exception capture — `captureOnError` itself is
 * unaffected.
 */
export async function invokeMatrix<T>(
  command: string,
  args: Record<string, unknown>,
  options?: InvokeOptions,
): Promise<T> {
  const result = await invoke<T>(command, args, {
    ...options,
    skipBreadcrumb: true,
    onFailureBreadcrumb: (error, durationMs) => {
      addMatrixIpcBreadcrumb("error", `${command} failed`, {
        command,
        durationMs,
        args: summarizeValue(args),
        error:
          error instanceof Error
            ? { name: error.name, message: summarizeValue(error.message) }
            : summarizeValue(error),
        status: "failure",
      });
    },
  });
  addMatrixIpcBreadcrumb("info", `${command} succeeded`, {
    command,
    args: summarizeValue(args),
    result: summarizeValue(result),
    status: "success",
  });
  return result;
}

/**
 * IPC types are generated from the Rust structs by ts-rs — see
 * `src-tauri/src/bindings/`, regenerated by `cargo test --lib` and drift-checked in CI
 * (any uncommitted change fails the build). They're re-exported here so the rest of the
 * frontend imports the IPC types and their `invoke`/`listen` wrappers from one place;
 * do not redefine them by hand.
 */
export type {
  BadgeState,
  CommandResult,
  CrossSigningStatusSummary,
  DeviceSummary,
  DiscoverHomeserverResponse,
  EmojiPair,
  EventReceipt,
  HistoryVisibilityKind,
  JoinRuleKind,
  LoginRequest,
  LoginResponse,
  MediaContent,
  MembershipKind,
  NotificationSettingsSummary,
  OwnProfile,
  PowerLevelThresholds,
  PresenceStateDto,
  PresenceUpdate,
  ProfileSummary,
  PusherKind,
  PushRegistration,
  PushStatus,
  QrLoginProgressEvent,
  ReactionGroup,
  ReactionToggleResult,
  ReceiptTypeDto,
  ReceiptUpdate,
  RecoveryStatusSummary,
  RegisterRequest,
  ReplyRef,
  RoomDetails,
  RoomMemberSummary,
  RoomMessageSummary,
  RoomMembershipKind,
  RoomNotificationModeKind,
  RoomPermissions,
  RoomSummary,
  RoomTimelineUpdate,
  SasUpdateEvent,
  SelfProfileUpdate,
  SendState,
  SlashCommand,
  SpaceBadgeState,
  SpaceChild,
  SpaceHierarchyNode,
  SpaceJoinRule,
  SyncStateEvent,
  TimelinePage,
  TypingUpdate,
  UploadProgress,
  VerificationRequestSummary,
};

// captureOnError: false — a failed login/register (wrong password,
// unreachable homeserver, etc.) is expected user-facing UX handled inline by
// LoginScreen, not a bug to report to Sentry.
export function login(request: LoginRequest): Promise<LoginResponse> {
  return invoke("login", { request }, { captureOnError: false });
}

export function register(request: RegisterRequest): Promise<LoginResponse> {
  return invoke("register", { request }, { captureOnError: false });
}

// captureOnError: false — this fires on every keystroke via
// useHomeserverDiscovery while the user is still typing a server name, so an
// unresolvable address is the common case, not an error worth reporting.
export function discoverHomeserver(input: string): Promise<DiscoverHomeserverResponse> {
  return invoke("discover_homeserver", { input }, { captureOnError: false });
}

// captureOnError: false — LoginScreen catches this to render the SSO error
// inline (e.g. the homeserver doesn't support SSO), the same expected-UX
// pattern as login/register above.
export function startSsoLogin(homeserverUrl: string): Promise<string> {
  return invoke("start_sso_login", { homeserverUrl }, { captureOnError: false });
}

// captureOnError: false — LoginScreen catches this too, including the
// expected "no SSO login is in progress" failure on a cold-launch deep link
// with a stale/duplicate callback.
export function completeSsoLogin(callbackUrl: string): Promise<LoginResponse> {
  return invoke("complete_sso_login", { callbackUrl }, { captureOnError: false });
}

export function cancelSsoLogin(): Promise<void> {
  return invoke("cancel_sso_login");
}

// captureOnError: false — QrLoginScreen renders this inline as its "error"
// stage (e.g. the homeserver doesn't support MSC4108 QR login).
export function startQrLogin(homeserverUrl: string): Promise<void> {
  return invoke("start_qr_login", { homeserverUrl }, { captureOnError: false });
}

// captureOnError: false — QrLoginScreen renders a wrong check code inline as
// its "error" stage, the same expected-UX pattern as a wrong password.
export function submitQrCheckCode(code: number): Promise<void> {
  return invoke("submit_qr_check_code", { code }, { captureOnError: false });
}

export function cancelQrLogin(): Promise<void> {
  return invoke("cancel_qr_login");
}

export function onQrLoginProgress(
  callback: (event: QrLoginProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<QrLoginProgressEvent>("qr_login:progress", (e) => callback(e.payload));
}

export function tryRestoreSession(): Promise<LoginResponse | null> {
  return invoke("try_restore_session");
}

export function listRooms(): Promise<RoomSummary[]> {
  return invoke("list_rooms");
}

export function acceptInvite(roomId: string): Promise<void> {
  return invoke("accept_invite", { roomId });
}

export function declineInvite(roomId: string): Promise<void> {
  return invoke("decline_invite", { roomId });
}

export function resolveRoomAlias(alias: string): Promise<string> {
  return invoke("resolve_room_alias", { alias });
}

/** Backs the composer's `@` mention autocomplete — see its doc comment for scope. */
export function getRoomMembers(roomId: string): Promise<RoomMemberSummary[]> {
  return invoke("get_room_members", { roomId });
}

export function onSyncState(callback: (event: SyncStateEvent) => void): Promise<UnlistenFn> {
  return listen<SyncStateEvent>("sync:state", (e) => callback(e.payload));
}

/** Tells the Rust side which room (if any) currently has focus, so the timeline listener can suppress a local notification for whatever room the user is already looking at (Spec 10). Pass `null` when no room is focused (e.g. the room list or settings has focus). */
export function setFocusedRoom(roomId: string | null): Promise<void> {
  return invoke("set_focused_room", { roomId });
}

/** Forces an immediate refresh of the native dock/taskbar/tray badge (Spec 10) — the sync loop already keeps it current every sync iteration, so this is only needed for an instant local update (e.g. right after marking a room read). */
export function setBadgeCount(count: number): Promise<void> {
  return invoke("set_badge_count", { count });
}

export function onBadgeUpdate(callback: (badge: BadgeState) => void): Promise<UnlistenFn> {
  return listen<BadgeState>("badge:update", (e) => callback(e.payload));
}

/** Whether this build targets a desktop OS (macOS/Windows/Linux), not mobile — see the Rust command's doc comment. */
export function isDesktopPlatform(): Promise<boolean> {
  return invoke("is_desktop_platform");
}

export function getAutostart(): Promise<boolean> {
  return invoke("get_autostart");
}

export function setAutostart(enabled: boolean): Promise<void> {
  return invoke("set_autostart", { enabled });
}

export function onRoomListUpdate(callback: (rooms: RoomSummary[]) => void): Promise<UnlistenFn> {
  return listen<RoomSummary[]>("room_list:update", (e) => callback(e.payload));
}

export function getTimelinePage(
  roomId: string,
  cursor?: string,
  limit?: number,
): Promise<TimelinePage> {
  return invoke("get_timeline_page", { roomId, cursor, limit });
}

/**
 * Queues a message and returns the SDK-generated send-queue transaction id.
 * The frontend doesn't need this for rendering any more (Spec 14): the
 * room's live `Timeline` creates the local echo itself and pushes it via
 * `timeline:update`, keyed on this same transaction id.
 */
export function sendMessage(
  roomId: string,
  body: string,
  formattedBody?: string | null,
  mentions?: string[] | null,
): Promise<string> {
  return invoke("send_message", {
    roomId,
    body,
    formattedBody: formattedBody ?? null,
    mentions: mentions ?? null,
  });
}

/** Runs a resolved slash command (see `parseSlashCommand` in `slashCommands.ts`). */
export function runCommand(
  roomId: string,
  command: SlashCommand,
  args: string[],
): Promise<CommandResult> {
  return invoke("run_command", { roomId, command, args });
}

export function onTimelineUpdate(
  callback: (update: RoomTimelineUpdate) => void,
): Promise<UnlistenFn> {
  return listen<RoomTimelineUpdate>("timeline:update", (e) => callback(e.payload));
}

export function editMessage(roomId: string, eventId: string, newBody: string): Promise<void> {
  return invoke("edit_message", { roomId, eventId, newBody });
}

export function redactEvent(
  roomId: string,
  eventId: string,
  reason?: string | null,
): Promise<void> {
  return invoke("redact_event", { roomId, eventId, reason: reason ?? null });
}

export function canRedact(roomId: string, targetSender: string): Promise<boolean> {
  return invoke("can_redact", { roomId, targetSender });
}

export function toggleReaction(
  roomId: string,
  targetEventId: string,
  key: string,
): Promise<ReactionToggleResult> {
  return invoke("toggle_reaction", { roomId, targetEventId, key });
}

/** Same transaction-id contract as {@link sendMessage} — see its doc comment. */
export function sendReply(roomId: string, inReplyToEventId: string, body: string): Promise<string> {
  return invoke("send_reply", { roomId, inReplyToEventId, body });
}

// captureOnError: false — UIA-gated. useUiaRetry treats both the initial
// UiaChallenge (already filtered) and any subsequent `Other` failure (wrong
// password on retry, or a real backend error the Rust side can't further
// distinguish per UiaCommandError's doc comment) the same way: surface it
// inline via `error`, not a bug report.
export function bootstrapCrossSigning(password?: string): Promise<void> {
  return invoke("bootstrap_cross_signing", { password }, { captureOnError: false });
}

export function crossSigningStatus(): Promise<CrossSigningStatusSummary> {
  return invoke("cross_signing_status");
}

export function recoveryStatus(): Promise<RecoveryStatusSummary> {
  return invoke("recovery_status");
}

// captureOnError: false — a wrong/invalid recovery key is an expected user-input
// error (same class as a wrong password), not a bug report; DevicesPanel already
// surfaces it inline via the mutation's own error state. `recoveryKey` itself never
// reaches Sentry either way: `observability/ipc.ts`'s arg-redaction pattern already
// matches `recovery_key`/`recoveryKey` field names.
export function recoverFromKey(recoveryKey: string): Promise<void> {
  return invoke("recover_from_key", { recoveryKey }, { captureOnError: false });
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

/**
 * `txnId` is caller-supplied (not server-generated) so it can match the ID
 * the frontend already used for its optimistic upload row before this call
 * — `upload:progress` events for this upload carry the same ID back.
 */
export function sendAttachment(
  roomId: string,
  filePath: string | File,
  txnId: string,
  caption?: string,
): Promise<void> {
  return invoke("send_attachment", { roomId, filePath, txnId, caption });
}

/**
 * Resolves the media attached to `eventId` in `roomId`, fetching,
 * decrypting, and caching on a miss. No handle crosses IPC: the frontend just
 * passes back the plain `(roomId, eventId)` pair it already has from
 * `RoomMessageSummary`'s `media` field ({@link MediaContent} carries display
 * metadata only). Desktop builds return a local path or asset URL; web builds
 * can return a companion `/api/...` or absolute URL. Pass the result through
 * `toLoadableMediaUrl` before assigning it to media elements.
 */
export function resolveMedia(roomId: string, eventId: string, thumbnail: boolean): Promise<string> {
  return invoke("resolve_media", { roomId, eventId, thumbnail });
}

export function onUploadProgress(
  callback: (progress: UploadProgress) => void,
): Promise<UnlistenFn> {
  return listen<UploadProgress>("upload:progress", (e) => callback(e.payload));
}

export function sendReadReceipt(
  roomId: string,
  eventId: string,
  isPrivate: boolean,
): Promise<void> {
  return invoke("send_read_receipt", { roomId, eventId, private: isPrivate });
}

export function sendTyping(roomId: string, typing: boolean): Promise<void> {
  return invoke("send_typing", { roomId, typing });
}

export function markRoomRead(roomId: string): Promise<void> {
  return invoke("mark_room_read", { roomId });
}

export function onReceiptsUpdate(callback: (update: ReceiptUpdate) => void): Promise<UnlistenFn> {
  return listen<ReceiptUpdate>("receipts:update", (e) => callback(e.payload));
}

export function onTypingUpdate(callback: (update: TypingUpdate) => void): Promise<UnlistenFn> {
  return listen<TypingUpdate>("typing:update", (e) => callback(e.payload));
}

export function setPresence(presence: PresenceStateDto, statusMsg?: string): Promise<void> {
  return invoke("set_presence", { presence, statusMsg });
}

export function getPresence(userId: string): Promise<PresenceUpdate | null> {
  return invoke("get_presence", { userId });
}

export function onPresenceUpdate(callback: (update: PresenceUpdate) => void): Promise<UnlistenFn> {
  return listen<PresenceUpdate>("presence:update", (e) => callback(e.payload));
}

export function getOwnProfile(): Promise<OwnProfile> {
  return invoke("get_own_profile");
}

/** Fires when the signed-in user's own display name/avatar changes out of band (e.g. from another client) — see `profiles.rs`'s module doc comment. */
export function onSelfProfileUpdate(
  callback: (update: SelfProfileUpdate) => void,
): Promise<UnlistenFn> {
  return listen<SelfProfileUpdate>("profile:self", (e) => callback(e.payload));
}

export function setRoomFavourite(roomId: string, favourite: boolean): Promise<void> {
  return invoke("set_room_favourite", { roomId, favourite });
}

/**
 * Reads a global Matrix account-data event by type, straight from the
 * server (not the local sync store) — see the Rust command's doc comment
 * for why. `null` when the event has never been set.
 */
export function getAccountData(eventType: string): Promise<unknown> {
  return invoke("get_account_data", { eventType });
}

export function setAccountData(eventType: string, content: unknown): Promise<void> {
  return invoke("set_account_data", { eventType, content });
}

/** Local (non-account-data) fast-path onboarding flag — see Spec 12's gate precedence. */
export function getLocalOnboardingFlag(userId?: string): Promise<boolean> {
  return isWebBuild()
    ? invoke("get_local_onboarding_flag", { userId })
    : invoke("get_local_onboarding_flag");
}

export function setLocalOnboardingFlag(userId?: string): Promise<void> {
  return isWebBuild()
    ? invoke("set_local_onboarding_flag", { userId })
    : invoke("set_local_onboarding_flag");
}

export function setRoomLowPriority(roomId: string, lowPriority: boolean): Promise<void> {
  return invoke("set_room_low_priority", { roomId, lowPriority });
}

export function setRoomMuted(roomId: string, muted: boolean): Promise<void> {
  return invoke("set_room_muted", { roomId, muted });
}

export function setRoomMarkedUnread(roomId: string, unread: boolean): Promise<void> {
  return invoke("set_room_marked_unread", { roomId, unread });
}

/** `order` is the fractional-index midpoint the caller computes between the room's two new neighbours in its section — see `RoomList.tsx`'s drag-reorder handler. */
export function setRoomManualOrder(roomId: string, order: number): Promise<void> {
  return invoke("set_room_manual_order", { roomId, order });
}

export function listSpaceChildren(spaceId: string): Promise<SpaceChild[]> {
  return invoke("list_space_children", { spaceId });
}

export function listSpaceHierarchy(spaceId: string): Promise<SpaceHierarchyNode[]> {
  return invoke("list_space_hierarchy", { spaceId });
}

/**
 * Returns the resolved room id (and whether it's a space), since
 * `roomIdOrAlias` may be an alias and/or the caller may not already know
 * the room's type.
 */
export function joinRoom(roomIdOrAlias: string): Promise<JoinedRoom> {
  return invoke("join_room", { roomIdOrAlias });
}

export function knockRoom(roomIdOrAlias: string, reason?: string): Promise<void> {
  return invoke("knock_room", { roomIdOrAlias, reason });
}

/** Creates a new space room and returns its room id. */
export function createSpace(
  name: string,
  topic?: string,
  roomAliasName?: string,
  isPublic = false,
): Promise<string> {
  return invoke("create_space", {
    name,
    topic: topic ?? null,
    roomAliasName: roomAliasName ?? null,
    public: isPublic,
  });
}

export function logout(): Promise<void> {
  return invoke("logout");
}

export function getProfile(): Promise<ProfileSummary> {
  return invoke("get_profile");
}

/**
 * Resolves `ProfileSummary.avatar_url` (a bare `mxc://` URI, not
 * webview-loadable directly) to a loadable source candidate, or `null` on any
 * resolution failure. Desktop builds return a local path or asset URL; web
 * builds can return a companion `/api/...` or absolute URL. Pass the result
 * through `toLoadableMediaUrl`, same convention as {@link resolveMedia}.
 */
export function resolveAvatar(mxcUrl: string): Promise<string | null> {
  return invoke("resolve_avatar", { mxcUrl });
}

export function setDisplayName(displayName: string | null): Promise<void> {
  return invoke("set_display_name", { displayName });
}

/** Tauri uploads read a filesystem path in Rust; web uploads pass a browser `File`. */
export function setAvatar(filePath: string | File): Promise<void> {
  return invoke("set_avatar", { filePath });
}

export function removeAvatar(): Promise<void> {
  return invoke("remove_avatar");
}

/**
 * UIA-gated: call with `password` omitted first; on failure, prompt for the
 * account password and retry with it — mirrors {@link bootstrapCrossSigning}.
 */
export function changePassword(newPassword: string, password?: string): Promise<void> {
  return invoke("change_password", { newPassword, password }, { captureOnError: false });
}

/** Same UIA retry convention as {@link changePassword}. */
export function deactivateAccount(password?: string): Promise<void> {
  return invoke("deactivate_account", { password }, { captureOnError: false });
}

/** `null` when there's no OIDC account-management URL to offer — see the Rust command's doc comment. */
export function getAccountDeactivateUrl(): Promise<string | null> {
  return invoke("get_account_deactivate_url");
}

export function listDevices(): Promise<DeviceSummary[]> {
  return invoke("list_devices");
}

/** Confirmed email/phone contact methods — display only (Spec 18). */
export function get3pids(): Promise<ThirdPartyIdSummary[]> {
  return invoke("get_3pids");
}

/** Matrix user ids on this account's ignore list (Spec 18). */
export function getIgnoredUsers(): Promise<string[]> {
  return invoke("get_ignored_users");
}

export function ignoreUser(userId: string): Promise<void> {
  return invoke("ignore_user", { userId });
}

export function unignoreUser(userId: string): Promise<void> {
  return invoke("unignore_user", { userId });
}

/** Same UIA retry convention as {@link changePassword}. */
export function deleteDevice(deviceId: string, password?: string): Promise<void> {
  return invoke("delete_device", { deviceId, password }, { captureOnError: false });
}

/** `null` when there's no OIDC account-management URL to offer — see the Rust command's doc comment. */
export function getDeviceDeleteUrl(deviceId: string): Promise<string | null> {
  return invoke("get_device_delete_url", { deviceId });
}

/**
 * Starts an outgoing SAS verification of another of this account's own
 * devices and returns the new flow id. Drives the same
 * `verification:request`/`verification:sas_update:*` events as an incoming
 * request — see `VerificationOverlay`.
 */
export function requestDeviceVerification(deviceId: string): Promise<string> {
  return invoke("request_device_verification", { deviceId });
}

/** `null` when there's no OIDC account-management URL to offer — see the Rust command's doc comment. */
export function getCrossSigningResetUrl(): Promise<string | null> {
  return invoke("get_cross_signing_reset_url");
}

export function getNotificationSettings(): Promise<NotificationSettingsSummary> {
  return invoke("get_notification_settings");
}

export function setDefaultNotificationMode(mode: RoomNotificationModeKind): Promise<void> {
  return invoke("set_default_notification_mode", { mode });
}

export function setRoomNotificationMode(
  roomId: string,
  mode: RoomNotificationModeKind,
): Promise<void> {
  return invoke("set_room_notification_mode", { roomId, mode });
}

export function addNotificationKeyword(keyword: string): Promise<void> {
  return invoke("add_notification_keyword", { keyword });
}

export function removeNotificationKeyword(keyword: string): Promise<void> {
  return invoke("remove_notification_keyword", { keyword });
}

/** See `NotificationSettingsSummary.global_mute` for what this toggles. */
export function setGlobalMute(muted: boolean): Promise<void> {
  return invoke("set_global_mute", { muted });
}

/** Preference-only for now — playback lands with the push-transport spec. */
export function setSoundEnabled(enabled: boolean): Promise<void> {
  return invoke("set_sound_enabled", { enabled });
}

export function getRoomDetails(roomId: string): Promise<RoomDetails> {
  return invoke("get_room_details", { roomId });
}

/** Every membership (including banned/left) — see `get_room_members` for the active-only autocomplete scope. */
export function getRoomMemberList(roomId: string): Promise<RoomMemberSummary[]> {
  return invoke("get_room_member_list", { roomId });
}

export function setRoomName(roomId: string, name: string): Promise<void> {
  return invoke("set_room_name", { roomId, name });
}

export function setRoomTopic(roomId: string, topic: string): Promise<void> {
  return invoke("set_room_topic", { roomId, topic });
}

/** Tauri uploads read a filesystem path in Rust; web uploads pass a browser `File`. */
export function setRoomAvatar(roomId: string, filePath: string | File): Promise<void> {
  return invoke("set_room_avatar", { roomId, filePath });
}

export function removeRoomAvatar(roomId: string): Promise<void> {
  return invoke("remove_room_avatar", { roomId });
}

export function setRoomJoinRule(roomId: string, joinRule: JoinRuleKind): Promise<void> {
  return invoke("set_room_join_rule", { roomId, joinRule });
}

export function setRoomHistoryVisibility(
  roomId: string,
  visibility: HistoryVisibilityKind,
): Promise<void> {
  return invoke("set_room_history_visibility", { roomId, visibility });
}

/** One-way — see `RoomDetails.is_encrypted`'s doc comment; there is no disable. */
export function enableRoomEncryption(roomId: string): Promise<void> {
  return invoke("enable_room_encryption", { roomId });
}

export function setMemberPowerLevel(
  roomId: string,
  userId: string,
  powerLevel: number,
): Promise<void> {
  return invoke("set_member_power_level", { roomId, userId, powerLevel });
}

export function setRoomPowerLevelThresholds(
  roomId: string,
  changes: PowerLevelThresholds,
): Promise<void> {
  return invoke("set_room_power_level_thresholds", { roomId, changes });
}

export function inviteMember(roomId: string, userId: string): Promise<void> {
  return invoke("invite_member", { roomId, userId });
}

export function kickMember(roomId: string, userId: string, reason?: string): Promise<void> {
  return invoke("kick_member", { roomId, userId, reason });
}

export function banMember(roomId: string, userId: string, reason?: string): Promise<void> {
  return invoke("ban_member", { roomId, userId, reason });
}

export function unbanMember(roomId: string, userId: string, reason?: string): Promise<void> {
  return invoke("unban_member", { roomId, userId, reason });
}

/** Fires for a joined room whenever a batch of state events (settings, power levels, membership) syncs — see `mod.rs`'s `emit_room_updates`. */
export function onRoomDetailsUpdate(callback: (details: RoomDetails) => void): Promise<UnlistenFn> {
  return listen<RoomDetails>("room_details:update", (e) => callback(e.payload));
}

/**
 * Registers this device for remote push (Spec 11): on desktop this is a
 * no-op returning `{ transport: "none", ... }` (see `push::active_transport`'s
 * doc comment — desktop has no remote-push transport by design), on mobile
 * it obtains a UnifiedPush/FCM/APNs endpoint and registers it as a pusher
 * with the homeserver.
 */
export function registerPush(): Promise<PushRegistration> {
  return invoke("register_push");
}

export function unregisterPush(): Promise<void> {
  return invoke("unregister_push");
}

export function getPushStatus(): Promise<PushStatus> {
  return invoke("get_push_status");
}

export function onPushStatus(callback: (status: PushStatus) => void): Promise<UnlistenFn> {
  return listen<PushStatus>("push:status", (e) => callback(e.payload));
}
