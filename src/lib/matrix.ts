import type { BadgeState } from "@bindings/BadgeState";
import type { BookmarkEntry } from "@bindings/BookmarkEntry";
import type { CommandResult } from "@bindings/CommandResult";
import type { DndSnapshot } from "@bindings/DndSnapshot";
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
import type { UrlPreview } from "@bindings/UrlPreview";
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
  BookmarkEntry,
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
  UrlPreview,
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

/** Spec 30: current Do Not Disturb state, auto-cleared server-side if a timed period already expired. */
export function getDndState(): Promise<DndSnapshot> {
  return invoke("get_dnd_state");
}

/** Spec 30: sets DND state. Rust persists it and is the single source of truth — also settable from the tray menu, which emits `dnd:changed` on any change (including ones made here) so both surfaces stay in sync. */
export function setDndState(
  enabled: boolean,
  until: number | null,
  expectedRevision: number,
): Promise<DndSnapshot> {
  return invoke("set_dnd_state", { enabled, until, expectedRevision });
}

/** Fires whenever DND state changes, from either the Settings panel or the tray menu. */
export function onDndChanged(callback: (state: DndSnapshot) => void): Promise<UnlistenFn> {
  return listen<DndSnapshot>("dnd:changed", (e) => callback(e.payload));
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
 * Spec 12's minimal "load timeline around an arbitrary event id" — pulls
 * older history into the room's live timeline (the same `paginate_backwards`
 * primitive `getTimelinePage` uses, pushed to the frontend via the existing
 * `timeline:update` listener) until `eventId` is loaded, or gives up.
 * Resolves to whether the event was found — `false` means it's further back
 * than this will paginate to, or no longer reachable.
 */
export function loadTimelineAroundEvent(roomId: string, eventId: string): Promise<boolean> {
  return invoke("load_timeline_around_event", { roomId, eventId });
}

/** Bookmarks (Spec 12: personal, private "saved messages" — never a Matrix
 * event of any kind, see `add_bookmark`'s Rust doc comment) a loaded message. */
export function addBookmark(roomId: string, eventId: string): Promise<void> {
  return invoke("add_bookmark", { roomId, eventId });
}

/** Removes a bookmark. A no-op if `eventId` isn't currently bookmarked. */
export function removeBookmark(eventId: string): Promise<void> {
  return invoke("remove_bookmark", { eventId });
}

/** Every bookmark for the current account, newest-saved first. */
export function listBookmarks(): Promise<BookmarkEntry[]> {
  return invoke("list_bookmarks");
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

/**
 * Whether the current user can redact *any other* member's message in this
 * room. Room-scoped, not sender-scoped: a redact check on someone else's
 * message only ever depends on the room's power levels and the current
 * user's own level, never on who sent it — so callers should fetch this once
 * per room instead of calling {@link canRedact} once per unique sender (see
 * that function's Rust counterpart, `can_redact_others_impl`, and Sentry
 * issue CHARM-3 for the N+1 this replaces).
 */
export function canRedactOthers(roomId: string): Promise<boolean> {
  return invoke("can_redact_others", { roomId });
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

/**
 * Retries a failed message send in place via the send queue's own retry
 * primitive (`SendHandle::unwedge`), rather than re-composing and sending
 * new content. `transactionId` is the failed local echo's
 * `RoomMessageSummary.transaction_id` (present while `send_state.state` is
 * `"error"`).
 */
export function resendMessage(roomId: string, transactionId: string): Promise<void> {
  return invoke("resend_message", { roomId, transactionId });
}

/**
 * Discards a failed message send by cancelling its local echo via the send
 * queue (`SendHandle::abort`) — there's nothing to redact since a failed
 * send was never accepted by the homeserver. Resolves `true` if the local
 * echo was actually removed, `false` if it was already gone (e.g. a
 * previous call already discarded it, or it succeeded in the meantime) —
 * either way the message should no longer show as failed.
 */
export function discardFailedMessage(roomId: string, transactionId: string): Promise<boolean> {
  return invoke("discard_failed_message", { roomId, transactionId });
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

/**
 * Fetches an unfurled preview (title, description, thumbnail) for `url` via
 * the homeserver's `/preview_url` endpoint (Spec 29). `roomId` is accepted
 * for parity with the Rust command's signature (room-scoped preview policy
 * is a possible future extension) but isn't otherwise used by the frontend.
 * Resolves to `null` on any failure — 404, timeout, malformed response, or
 * a page with no usable OpenGraph data — never rejects for those cases; the
 * caller doesn't need a try/catch to render "no preview".
 */
export function getUrlPreview(
  roomId: string,
  url: string,
  eventTsMs?: number | null,
): Promise<UrlPreview | null> {
  return invoke("get_url_preview", { roomId, url, eventTsMs: eventTsMs ?? null });
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
 * request — see `VerificationOverlay`. Captured on failure like most
 * commands (unlike the neighboring device-management wrappers): the Rust
 * command's "device not found" case doesn't interpolate the device ID into
 * its error text (see `devices.rs`), so it's safe to keep default capture —
 * and a genuine SDK/store/network failure from `get_device`/
 * `request_verification` here is exactly the kind of regression Sentry
 * should surface.
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

/** Leaves a room (or space) on the caller's own behalf. */
export function leaveRoom(roomId: string): Promise<void> {
  return invoke("leave_room", { roomId });
}

/** Adds an already-joined room or space as a child of `spaceId` (Spec 63's "Add Existing" flow). */
export function addExistingSpaceChild(spaceId: string, childRoomId: string): Promise<void> {
  return invoke("add_existing_space_child", { spaceId, childRoomId });
}

/** Detaches `childRoomId` from `spaceId`'s hierarchy without leaving the child room/space itself. */
export function removeSpaceChild(spaceId: string, childRoomId: string): Promise<void> {
  return invoke("remove_space_child", { spaceId, childRoomId });
}

/** Marks (or unmarks) `childRoomId` as a "suggested" child of `spaceId`. */
export function setSpaceChildSuggested(
  spaceId: string,
  childRoomId: string,
  suggested: boolean,
): Promise<void> {
  return invoke("set_space_child_suggested", { spaceId, childRoomId, suggested });
}

/** Server-published (room-directory) aliases for `roomId` — distinct from `RoomDetails.canonical_alias`/`alt_aliases`. */
export function getRoomLocalAliases(roomId: string): Promise<string[]> {
  return invoke("get_room_local_aliases", { roomId });
}

/** Advisory pre-check before `addRoomAlias` — a `false` here should surface as "already in use"; a `true` doesn't guarantee the following create will still succeed (TOCTOU). */
export function checkRoomAliasAvailable(alias: string): Promise<boolean> {
  return invoke("check_room_alias_available", { alias });
}

/** Publishes `alias` in the homeserver's room directory. Does not set it as canonical — call `setCanonicalAlias` separately. */
export function addRoomAlias(roomId: string, alias: string): Promise<void> {
  return invoke("add_room_alias", { roomId, alias });
}

/** Unpublishes `alias` from the homeserver's room directory. Does not touch `m.room.canonical_alias`. */
export function removeRoomAlias(alias: string): Promise<void> {
  return invoke("remove_room_alias", { alias });
}

/** Sets or clears `m.room.canonical_alias`'s `alias` field. Pass `null` to clear. */
export function setCanonicalAlias(roomId: string, alias: string | null): Promise<void> {
  return invoke("set_canonical_alias", { roomId, alias });
}

/** Removes `alias` from `m.room.canonical_alias`'s `alt_aliases` list without touching the canonical `alias` field. */
export function removeAltAlias(roomId: string, alias: string): Promise<void> {
  return invoke("remove_alt_alias", { roomId, alias });
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
