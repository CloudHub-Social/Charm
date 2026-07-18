import { useEffect, useMemo, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  ArrowLeft,
  ChevronDown,
  Info,
  MessageCircle,
  MoreVertical,
  Paperclip,
  Send,
  Settings,
  Type,
  X,
} from "lucide-react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ConfirmWithReasonDialog } from "@/components/ui/confirm-with-reason-dialog";
import { PresenceDot } from "@/features/presence/PresenceDot";
import { usePresence } from "@/features/presence/usePresence";
import { cn } from "@/lib/utils";
import { useAdaptiveLayout } from "@/features/shell/useAdaptiveLayout";
import { useFlag } from "@/featureFlags";
import { eventPermalink, userIdServerName } from "@/lib/matrixPermalink";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isWebBuild } from "@/lib/platform";
import {
  canRedactOthers,
  loadTimelineAroundEvent,
  onRoomDetailsUpdate,
  type RoomSummary,
} from "@/lib/matrix";
import { avatarColor, displayName, initials, resolveAvatar } from "./roomDisplay";
import { Composer, type ComposerHandle, type ComposerMode } from "./Composer";
import { type MessageActionsHandle } from "./MessageActions";
import { MessageRow, messageRowKey } from "./MessageRow";
import { ReplyPreview } from "./ReplyPreview";
import { UploadTray } from "./UploadTray";
import {
  activeReplyTargetAtomFamily,
  editingEventIdAtomFamily,
  noRoomActiveReplyTargetAtom,
  noRoomEditingEventIdAtom,
} from "./messageActionAtoms";
import { escapeHtmlText, sanitizeMatrixHtml } from "./composerSanitize";
import {
  membersDrawerOpenAtomFamily,
  noRoomMembersDrawerOpenAtom,
  roomSettingsAtom,
} from "@/features/room-info/roomInfoAtoms";
import { useReadReceipts } from "./useReadReceipts";
import { followingLabel, useRoomParticipants } from "./useRoomParticipants";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { attachmentUploadPayload, useAttachmentUploads } from "./useAttachmentUploads";
import { useChatTimeline } from "./useChatTimeline";
import {
  formatDateDividerLabel,
  isDateDividerBoundary,
  unreadDividerIndex,
} from "./timelineDividers";
import { useChatTyping } from "./useChatTyping";
import { useMessageActions } from "./useMessageActions";
import { useMessageSend } from "./useMessageSend";
import { MessagePillProfileDialog, type MessagePillProfile } from "./MessagePillProfileDialog";

// How long a successful `loadTimelineAroundEvent` gets to have its
// `timeline:update` land (and clear the jump the normal way) before the
// jump-in-progress effect force-clears it itself — see that fallback's own
// comment for why this exists at all.
const JUMP_FALLBACK_TIMEOUT_MS = 5000;

interface ChatShellProps {
  room: RoomSummary | null;
  currentUserId: string;
  onBack?: () => void;
  onNavigateToRoom?: (roomIdentifier: string) => void;
  /**
   * An event id to scroll to as soon as it's loaded in this room's timeline
   * (Spec 12's Saved Messages "jump to message"). Set by the caller after
   * selecting the bookmark's room; cleared via `onJumpHandled` once the jump
   * completes (found and scrolled to) or definitively fails (not reachable
   * even after `loadTimelineAroundEvent`), so a stale target doesn't
   * re-trigger a jump on some unrelated later render.
   */
  jumpToEventId?: string | null;
  onJumpHandled?: () => void;
}

/** Virtuoso `Header` component (Spec 26 Phase 2) — reads `loadingMore` off
 * Virtuoso's `context` prop rather than closing over component state, so it's
 * a stable reference across renders instead of being redefined on every one. */
function LoadingOlderHeader({ context }: { context?: { loadingMore: boolean; hasMore: boolean } }) {
  if (context?.loadingMore) {
    return (
      <p className="pb-2 text-center text-xs text-muted-foreground">Loading older messages…</p>
    );
  }
  if (context && !context.hasMore) {
    return (
      <div className="flex items-center gap-3 pb-3 text-[11px] font-medium text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <span>You're all caught up</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }
  return null;
}

function hasDraggedFiles(dataTransfer: DataTransfer): boolean {
  return dataTransfer.files.length > 0 || Array.from(dataTransfer.types).includes("Files");
}

/**
 * Per-message affordance state: whether the current user sent it, and
 * whether they're allowed to redact it (own messages always; others gated
 * by the room's redact power level). A redact check on someone else's
 * message depends only on the room's power levels and the current user's
 * own level — never on who actually sent it (see `can_redact_others_impl`'s
 * doc comment) — so this fetches `canRedactOthers` once per room rather than
 * once per unique sender. The prior per-sender `canRedact` version was a
 * pure N+1: every additional sender in a room repeated an identical query
 * (Sentry issue CHARM-3, Seer-confirmed root cause in this hook).
 * Resolution happens in an effect (not during render) so it can safely call
 * `setState` without triggering React's render-loop guard.
 */
function useCanRedactMap(roomId: string, currentUserId: string, senders: readonly string[]) {
  // A monotonic token bumped every time `roomId` changes, including
  // *returning* to a room previously visited — `roomId` alone isn't
  // sufficient to key a trusted resolved value, since it's reused on
  // re-entry: if the user was demoted from redact power while away, the
  // earlier visit's `allowed=true` would otherwise be trusted again as
  // soon as the room is reselected, for the whole window before the fresh
  // fetch below resolves (Codex review on #287, P2 — a follow-up on the
  // cross-room leak this hook already guards against). Bumped via React's
  // documented "adjusting state during render" pattern
  // (react.dev/learn/you-might-not-need-an-effect), not an effect, so the
  // stale value is invalidated before this render is ever painted rather
  // than after — the same reasoning that motivated deriving
  // `canRedactOthersInRoom` from render at all instead of an effect reset.
  const [activation, setActivation] = useState(() => ({ roomId, token: 0 }));
  if (activation.roomId !== roomId) {
    setActivation({ roomId, token: activation.token + 1 });
  }

  // Tagged with the activation it resolved *for* (not the room, and not a
  // plain boolean) — derived against the current activation at render time
  // below, rather than reset by a passive effect. An effect-based reset
  // doesn't run until *after* the new room's first paint, so that first
  // render would still see the *previous* activation's resolved value: a
  // room where redact was allowed, immediately followed by one where it
  // isn't (or the same room re-entered after a demotion), could briefly
  // show — and let the user submit — a Delete action the server then
  // rejects (Codex review on #287, P3, and the P2 above extending it to
  // same-room re-entry).
  const [resolvedPermission, setResolvedPermission] = useState<{
    token: number;
    allowed: boolean;
  } | null>(null);
  const canRedactOthersInRoom =
    resolvedPermission?.token === activation.token ? resolvedPermission.allowed : false;
  // Tracks the activation a `canRedactOthers` call was actually issued for,
  // so its resolution can be checked against whatever activation is
  // current by the time it lands — without this, a slow response for a
  // room the user has since navigated away from (or back to, bumping the
  // token again) can overwrite a *different*, already-current activation's
  // permission result.
  const activationTokenRef = useRef(activation.token);
  activationTokenRef.current = activation.token;

  useEffect(() => {
    // No room selected (ChatShell's empty state, before its `if (!room)`
    // early return further down) — `canRedactOthers("")` would fail on
    // both the Rust IPC path (`RoomId::parse("")`) and the web transport
    // (`/api/rooms//can-redact-others`), surfacing as a spurious
    // backend/Sentry error on nothing but opening/closing a room (Codex
    // review on #287, P2).
    if (!roomId) return undefined;

    const requestedToken = activation.token;
    // A per-request sequence number, distinct from `activation.token`: the
    // token alone only distinguishes *activations* (room changes), not
    // multiple in-flight requests *within* the same activation. The initial
    // fetch below and a later `room_details:update`-triggered refetch share
    // one token, so without this, the initial request resolving *after* the
    // refetch (e.g. the refetch answering a demotion faster) would overwrite
    // the fresher, already-current result with its own stale one (Codex
    // review on #287, P2). Only the highest sequence number seen so far is
    // ever applied, regardless of resolution order.
    let latestRequestSeq = 0;
    const fetchPermission = () => {
      latestRequestSeq += 1;
      const requestSeq = latestRequestSeq;
      canRedactOthers(roomId)
        .then((allowed) => {
          if (activationTokenRef.current !== requestedToken) return;
          if (requestSeq !== latestRequestSeq) return;
          setResolvedPermission({ token: requestedToken, allowed });
        })
        .catch(logAndIgnore);
    };
    fetchPermission();

    // Re-fetches on `room_details:update`, not just on room entry: a power
    // level change (promotion/demotion) while the room stays open used to
    // leave `canRedactOthersInRoom` stuck at whatever it was when the room
    // was entered, silently hiding or wrongly showing the Delete affordance
    // until the user switched rooms (Codex review on #287, P2).
    const unlistenPromise = onRoomDetailsUpdate((details) => {
      if (details.room_id === roomId) fetchPermission();
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(logAndIgnore);
    };
  }, [roomId, activation.token]);

  return useMemo(() => {
    const bySender: Record<string, boolean> = {};
    for (const sender of senders) {
      bySender[sender] = sender === currentUserId || canRedactOthersInRoom;
    }
    return bySender;
  }, [senders, currentUserId, canRedactOthersInRoom]);
}

export function ChatShell({
  room,
  currentUserId,
  onBack,
  onNavigateToRoom,
  jumpToEventId = null,
  onJumpHandled,
}: ChatShellProps) {
  const layout = useAdaptiveLayout();
  const mobileChatRedesignEnabled = useFlag("mobile_chat_redesign");
  const messageActionParityEnabled = useFlag("message_action_parity");
  const mediaSendPolishEnabled = useFlag("media_send_polish");
  const mobile = layout === "mobile" && mobileChatRedesignEnabled;
  const [showMobileFormatting, setShowMobileFormatting] = useState(false);
  const composerRef = useRef<ComposerHandle>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const fileDragLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Drives the Send button's `disabled` state — there's no attachment
  // concept in the composer today (files upload and send independently via
  // `useAttachmentUploads`), so trimmed text emptiness is the only signal.
  const [isComposerEmpty, setIsComposerEmpty] = useState(true);
  const [followingExpanded, setFollowingExpanded] = useState(false);
  const [pillProfile, setPillProfile] = useState<MessagePillProfile | null>(null);
  const [redactionTargetEventId, setRedactionTargetEventId] = useState<string | null>(null);
  const [fileDragActive, setFileDragActive] = useState(false);
  // On touch, `MessageActions`' own trigger buttons are hover-only and thus
  // invisible/undiscoverable — a long-press on the bubble itself is what
  // users actually try. Forwarding the row's touch events to each
  // `MessageActions` instance via this ref map lets a long-press anywhere
  // on the row open that message's action menu.
  const actionsRefs = useRef<Map<string, MessageActionsHandle>>(new Map());
  const roomId = room?.room_id ?? "";
  const activeRoomId = room?.room_id ?? null;
  const permalinkViaServer = userIdServerName(currentUserId);
  useEffect(() => {
    setShowMobileFormatting(false);
    setRedactionTargetEventId(null);
    if (fileDragLeaveTimerRef.current !== null) {
      clearTimeout(fileDragLeaveTimerRef.current);
      fileDragLeaveTimerRef.current = null;
    }
    setFileDragActive(false);
    return () => {
      if (fileDragLeaveTimerRef.current !== null) {
        clearTimeout(fileDragLeaveTimerRef.current);
        fileDragLeaveTimerRef.current = null;
      }
    };
  }, [activeRoomId]);
  const [replyTarget, setReplyTarget] = useAtom(
    room ? activeReplyTargetAtomFamily(roomId) : noRoomActiveReplyTargetAtom,
  );
  const [editingEventId, setEditingEventId] = useAtom(
    room ? editingEventIdAtomFamily(roomId) : noRoomEditingEventIdAtom,
  );
  const [membersDrawerOpen, setMembersDrawerOpen] = useAtom(
    room ? membersDrawerOpenAtomFamily(roomId) : noRoomMembersDrawerOpenAtom,
  );
  const roomSettingsTarget = useAtomValue(roomSettingsAtom);
  const setRoomSettingsTarget = useSetAtom(roomSettingsAtom);
  // Room settings is a full modal covering the chat — messages arriving (or
  // already at the bottom) behind it shouldn't be silently marked read, same
  // reasoning as `RoomsScreen`'s focus-suppression check for this atom.
  const roomSettingsOpen = roomSettingsTarget !== null;
  const {
    messages,
    loading,
    loadingMore,
    hasMore,
    paginationError,
    firstItemIndex,
    prependedCount,
    loadMoreHistory,
    handleAtBottomStateChange,
    resetToLive,
  } = useChatTimeline(room, roomSettingsOpen, jumpToEventId !== null);
  // Auto-paginates when the newest page comes back with zero *renderable*
  // messages but more history to page back through — some Matrix timeline
  // items (state events, polls, etc.) are filtered out of
  // `RoomMessageSummary` entirely, so a room whose latest page is all such
  // items would otherwise render "No messages yet" with Virtuoso never
  // mounted at all (gated on `messages.length > 0` below), meaning its
  // `startReached` sentinel never exists to trigger the load the normal way.
  // `!paginationError` stops this from retrying forever against a
  // persistent backend/network failure — a rejected `loadMoreHistory()`
  // otherwise leaves every other dependency here unchanged once `loadingMore`
  // flips back to `false`, which would immediately re-trigger it again.
  useEffect(() => {
    if (!loading && messages.length === 0 && hasMore && !loadingMore && !paginationError) {
      loadMoreHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `loadMoreHistory` closes over refs, not state.
  }, [loading, messages.length, hasMore, loadingMore, paginationError]);
  // While this is true, `messages` is empty only because the empty-first-
  // page auto-pagination above is still working toward either real content
  // or a confirmed-exhausted history — not because the room's history is
  // actually empty. The various "seed once per room" effects below
  // (entrance-animation seen-set, unread-divider boundary) must not treat
  // this transient empty array as the room's real initial state: doing so
  // would permanently mark the seed as done against zero messages, so the
  // *real* first batch (whenever auto-pagination finds it) would incorrectly
  // read as a fresh arrival — animating in and (if scrolled away, though
  // unlikely this early) counting toward the jump-to-present pill — and
  // would freeze the unread divider's position against an empty snapshot
  // instead of the room's actual unread boundary.
  const awaitingEmptyPagePagination = messages.length === 0 && hasMore && !paginationError;
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // Mirrors Virtuoso's `atBottomStateChange` — drives the "jump to present"
  // pill's visibility (Spec 26 Phase 2). Starts `true` since a freshly
  // opened room always renders scrolled to bottom.
  const [atBottom, setAtBottom] = useState(true);
  // Mirrors `atBottom` for the "jump to present" pill's counting effect
  // below, which must read its *current* value only at the moment a real
  // `messages` update commits — not re-run its counting logic merely because
  // `atBottom` itself changed. See that effect's comment for the bug this
  // avoids: `newMessageKeys`'s `useMemo` returns the same memoized Set across
  // renders where `messages`/`loading`/`loadingMore`/`activeRoomId` didn't
  // change, so a plain `[newMessageKeys, atBottom]` dependency list would
  // recount that same stale Set every time the user's scroll position
  // changes, not just when new messages actually arrive.
  const atBottomRef = useRef(atBottom);
  atBottomRef.current = atBottom;
  // Count of not-yet-seen messages that arrived while scrolled away from
  // bottom, INCLUDING the current user's own — sending through the composer
  // or a `/me` slash command already scrolls to present explicitly (see
  // `scrollToPresentAfterOwnSend`), which flips `atBottom` back to `true`
  // before that message ever lands, so it never reaches this counter in
  // practice. But an own message can also arrive from a path this component
  // doesn't explicitly scroll for — another device, or a future send path
  // (e.g. an attachment upload) — and excluding *all* own messages
  // unconditionally would leave the user with no visible way back to it in
  // exactly that case. Reset to 0 once the user is back at bottom, whether
  // by scrolling there themselves or by clicking the pill.
  const [newMessageCount, setNewMessageCount] = useState(0);
  // Review fix: mirrors `mightHaveFocusedViewRef` as render-visible state.
  // The ref alone can't drive the "Jump to Present" pill's visibility below
  // — a focused (`TimelineFocus::Event`) view never receives live updates,
  // so `newMessageCount` stays 0 after such a jump and the pill (gated on
  // `!atBottom && newMessageCount > 0`) would never appear, leaving the
  // user with no in-room way to reset back to live short of leaving and
  // reopening the room.
  const [hasFocusedView, setHasFocusedView] = useState(false);
  // Review fix: set from `loadTimelineAroundEvent`'s own
  // `installed_focused_view` flag — *not* preemptively before calling it.
  // An earlier version set this unconditionally whenever the call was made
  // at all, but most jumps resolve via the cheap already-cached-live-
  // timeline or bounded-backward-pagination paths, neither of which ever
  // installs a `TimelineFocus::Event` backend timeline — only the rarer
  // server `/context` fallback does. Setting it regardless meant
  // `handleJumpToPresent` forced an unnecessary live re-fetch (replacing
  // `messages` and disrupting Virtuoso's scroll) for the much more common
  // non-focusing case. Read by `handleJumpToPresent` to decide whether it's
  // worth forcing that re-fetch — see its own comment for why that must
  // stay conditional rather than unconditional. Declared here (not lower,
  // where it's actually assigned) so the synchronous room-change reset
  // below — which runs during render, not in an effect — can reference it.
  const mightHaveFocusedViewRef = useRef(false);
  function handleVirtuosoAtBottomStateChange(bottom: boolean) {
    handleAtBottomStateChange(bottom);
    setAtBottom(bottom);
    if (bottom) setNewMessageCount(0);
  }
  function handleJumpToPresent() {
    // Review fix: if a Saved Messages jump previously fell back to the Rust
    // `TimelineFocus::Event` path, the room's cached backend `Timeline` is
    // still the focused one — nothing else resets it back to live for an
    // already-open room (see `resetToLive`'s own comment). Without this,
    // "Jump to Present" would only scroll within whatever's loaded in that
    // possibly-narrow focused window and the room would keep missing live
    // updates entirely.
    //
    // Review fix (E2E regression): only when `mightHaveFocusedViewRef` is
    // set — i.e. a jump for *this* room actually called
    // `loadTimelineAroundEvent` at some point — not on every click. The far
    // more common case (no bookmark jump ever happened, or the jump
    // resolved from the already-loaded live page without ever calling
    // `loadTimelineAroundEvent`) never touched the backend's focused-view
    // path at all, so forcing a network re-fetch here is both unnecessary
    // and actively wrong: it replaces `messages` out from under the
    // scroll Virtuoso is mid-animating to, which is what broke
    // `e2e/timeline-scroll.spec.ts`'s plain "scroll away, new message
    // arrives, click the pill" case.
    if (mightHaveFocusedViewRef.current) {
      // Review fix: `resetToLive` swallows its own errors internally (its
      // own comment) and always resolves — never rejects — so clearing
      // these flags *before* awaiting it treated a failed reset as if it
      // had succeeded. The room stayed on the backend's focused timeline
      // (missing live updates) while the "Jump to Present" affordance that
      // was the user's only in-room way to retry had already disappeared,
      // with no recovery short of leaving and reopening the room. Only
      // clear the flags once the reset actually reports success.
      resetToLive()
        .then((succeeded) => {
          if (succeeded) {
            mightHaveFocusedViewRef.current = false;
            setHasFocusedView(false);
          }
        })
        .catch(logAndIgnore);
    }
    // `"LAST"` (rather than the equivalent `messages.length - 1`): Virtuoso's
    // own sentinel for "the actual last data item," regardless of
    // `firstItemIndex` — reads slightly clearer than the plain arithmetic and
    // needs no `messages` dependency to stay correct. (`scrollToIndex`'s
    // numeric `index` is a plain 0-based position into `data`, clamped
    // against its length — *not* offset by `firstItemIndex`, unlike the
    // numbering `itemContent`/`computeItemKey` receive; see
    // `handleJumpToMessage`'s comment for the bug that distinction caused.)
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
    // Same reconciliation path as Virtuoso's own `atBottomStateChange` (mark-
    // as-read, pill reset) rather than only updating local `atBottom` state
    // — a real Virtuoso may not synchronously report "at bottom" right after
    // an imperative `scrollToIndex`, so this click is treated as having
    // already arrived rather than waiting on that callback to catch up.
    handleVirtuosoAtBottomStateChange(true);
  }
  // Scrolls to a loaded message by event id — the reply-preview "jump to the
  // replied-to message" click used to be a plain
  // `document.getElementById(...).scrollIntoView(...)`, which only ever
  // worked because every message was permanently mounted in the old flat
  // `.map()`. Under Virtuoso, a loaded-but-currently-offscreen message has no
  // DOM node to find, so this instead looks up its position in `messages`
  // and scrolls the virtualizer there directly. A no-op if the target isn't
  // (or is no longer) in the currently-loaded array — e.g. it's further back
  // than backward pagination has reached, same as the old behavior silently
  // doing nothing for a message that was never in the DOM to begin with.
  //
  // `scrollToIndex`'s numeric `index` is a plain 0-based position into the
  // current `data` array — clamped against `data.length`, not offset by
  // `firstItemIndex` — despite `itemContent`/`computeItemKey` receiving that
  // `firstItemIndex`-shifted "absolute" numbering for their own (unrelated)
  // purpose. Passing `firstItemIndex + index` here (as an earlier version
  // did, matching the reasoning for `"LAST"` above) is a huge, always-out-
  // of-range number that Virtuoso's own clamping silently resolves to the
  // *last* item — every reply jump before this fix landed on the newest
  // message instead of the replied-to one.
  function handleJumpToMessage(eventId: string) {
    const index = messages.findIndex((m) => m.event_id === eventId);
    if (index < 0) return;
    virtuosoRef.current?.scrollToIndex({
      index,
      align: "center",
      behavior: "smooth",
    });
  }
  // Jump-to-present state (Spec 26 Phase 2) lives here in `ChatShell`, not in
  // `useChatTimeline` or on the (per-room-remounted) Virtuoso instance —
  // switching rooms while scrolled away and mid-pill in room A must not
  // leave A's stale `atBottom`/`newMessageCount` visible over room B's first
  // render, before B's own `atBottomStateChange` has fired. Reset
  // synchronously during render (React's documented "adjusting state when a
  // prop changes" pattern), not in a passive `useEffect`: an effect only
  // runs *after* paint, so room B's first frame would still show room A's
  // stale pill (and could even count an immediate room-B update as "arrived
  // while scrolled away") for one frame before the effect caught up.
  //
  // Review fix: `hasFocusedView`/`mightHaveFocusedViewRef` used to be reset
  // in a separate `useEffect` instead of here — that effect fires after
  // this same room change, but still one paint *after* this synchronous
  // block runs, so room B's first frame could briefly render the generic
  // "Jump to present" pill left over from room A's focused jump (and
  // clicking it would call `resetToLive()` for the wrong room, since
  // `handleJumpToPresent` reads these same two values). Consolidated into
  // this same synchronous reset so both frames stay correct together.
  const previousActiveRoomIdForPillRef = useRef(activeRoomId);
  if (previousActiveRoomIdForPillRef.current !== activeRoomId) {
    previousActiveRoomIdForPillRef.current = activeRoomId;
    setAtBottom(true);
    setNewMessageCount(0);
    // A genuinely different room's own room-open effect already forces its
    // timeline live (`useChatTimeline`'s `forceLive` fetch) — these two are
    // specifically about *this* room possibly still being focused from an
    // earlier jump, which doesn't carry over to a different room id.
    mightHaveFocusedViewRef.current = false;
    setHasFocusedView(false);
  }
  // Tracks which message rows have already been rendered once, keyed by
  // `messageRowKey`, so only genuinely new arrivals get the slide-up+fade
  // entrance — not every row on initial load/pagination.
  //
  // Seeding waits for a *transition* into `loading === false` for the
  // active room, not just "loading currently reads false": `useChatTimeline`
  // initializes its own `loading` state to `false` and only flips it to
  // `true` inside an effect, which hasn't run yet on this component's very
  // first render — so `loading` misleadingly reads `false` on that render
  // too, alongside `messages` still being `[]`/stale. Seeding there would
  // treat the *next* render (the room's real initial page arriving) as
  // "seen for the first time", making every historical message look new
  // and animate in. `hasStartedLoadingRoomIdRef` records having actually
  // observed `loading === true` for this room first, so seeding only fires
  // once real loading has demonstrably started and then finished.
  //
  // Diffed and marked-seen inside a `useMemo` keyed on `messages` itself
  // (not a plain `useEffect` with no dependency array) so this only runs
  // once per actual `messages` update, not on every render — ChatShell
  // re-renders for plenty of reasons unrelated to the timeline (typing
  // indicator ticks, the following-bar fetch, etc.), and an effect with no
  // deps re-adding the same keys on one of those incidental re-renders would
  // flip a message's `isNew` back to `false` before the animation ever gets
  // committed to the DOM.
  const seenRowKeysRef = useRef<Set<string>>(new Set());
  // Own messages' `messageRowKey` (transaction_id ?? event_id) changes the
  // moment the homeserver acks a pending send — `transaction_id` reverts to
  // `null` and `event_id` becomes the real Matrix event id (see
  // `messageRowKey`'s own doc comment). A message already marked seen under
  // its pending key would otherwise look "fresh" again under its post-ack
  // key if the user scrolled away between the two — reappearing in the
  // jump-to-present pill for a message that was already visible before they
  // left. `timestamp_ms` doesn't change across that transition, so it's used
  // here as a stable secondary identity for the current user's own messages
  // specifically (this doesn't apply to the entrance animation, which
  // already excludes all own messages from `isNew` unconditionally).
  const seenOwnTimestampsRef = useRef<Set<number>>(new Set());
  const seededRoomIdRef = useRef<string | null>(null);
  const hasStartedLoadingRoomIdRef = useRef<string | null>(null);
  if (loading) hasStartedLoadingRoomIdRef.current = activeRoomId;
  // Closing a room (activeRoomId -> null) and later reopening the *same*
  // room id must go through the seed dance again from scratch: messages
  // that arrived while it was closed were never diffed against
  // `seenRowKeysRef`, so without this reset the stale refs from the prior
  // visit would either skip reseeding (letting old-but-unseen messages
  // animate) or diff against a now-irrelevant baseline.
  if (activeRoomId === null) {
    seededRoomIdRef.current = null;
    hasStartedLoadingRoomIdRef.current = null;
  }
  // Drives Spec 12's Saved Messages "jump to message": the caller
  // (`RoomsScreen`) selects the bookmark's room and sets `jumpToEventId`;
  // once that room is actually the active one, this either scrolls straight
  // to it (already loaded — same path as a reply-preview click) or triggers
  // `loadTimelineAroundEvent` to paginate it in first. Re-runs whenever
  // `messages` updates (each `timeline:update` from that pagination) so it
  // notices the moment the target becomes loaded, but only issues the
  // load-around request once per `jumpToEventId` value — `loadRequestedForRef`
  // guards against re-firing it on every subsequent `messages` update while
  // that request is still in flight.
  const loadRequestedForRef = useRef<string | null>(null);
  // Review fix: `load_timeline_around_event`'s Rust-side focused-timeline
  // fallback can install its listener and have that listener emit the
  // `timeline:update` carrying the target event *before* the IPC promise
  // itself resolves. In that ordering, the already-loaded branch below
  // fires first, clears `loadRequestedForRef` and calls `onJumpHandled`,
  // so when the promise's own `.then()` runs afterward, its
  // `loadRequestedForRef.current !== requestKey` guard (there to reject
  // truly superseded/stale requests) trips for this still-relevant one too
  // — losing `installed_focused_view` entirely, even though Rust really
  // did swap the room to a focused timeline. This tracks "already handled
  // via the already-loaded branch, but still need this specific request's
  // `installed_focused_view` once it resolves" independently of the dedup
  // ref, so the `.then()` can still apply it without re-doing anything
  // else (scroll/`onJumpHandled` already happened).
  const handledAwaitingFocusedViewRef = useRef<string | null>(null);
  // Review fix: fallback for a `found: true` `loadTimelineAroundEvent`
  // result whose corresponding `timeline:update` never lands (or is
  // dropped) — see that branch's own comment for why this is needed.
  // Holds the pending fallback's timer id, so the normal (update-arrives)
  // path can cancel it instead of leaving a stale timer that could
  // force-clear a *later*, unrelated jump for the same room+event key.
  const jumpFallbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Review fix: `loadRequestedForRef` is keyed by room id *and* event id,
  // but was never cleared on a plain room switch — `ChatShell` isn't
  // remounted between rooms (same instance, just a new `room` prop), so if
  // a Saved Messages jump in room A is still awaiting its own
  // `loadTimelineAroundEvent` call when the user switches to room B (which
  // has no pending jump of its own), that promise's `.then()`/`.catch()`
  // still find `loadRequestedForRef.current` unchanged and matching their
  // closed-over room-A request key once they finally settle — acting on a
  // stale result (setting `hasFocusedView` for room B, or clearing the
  // *new* `jumpToEventId` the parent may have already set for room B) as if
  // it were about the room the user is now looking at. Reset synchronously
  // during render (not in an effect, which would run one paint too late)
  // the moment the active room actually changes.
  const previousJumpRoomIdRef = useRef(room?.room_id ?? null);
  if (previousJumpRoomIdRef.current !== (room?.room_id ?? null)) {
    previousJumpRoomIdRef.current = room?.room_id ?? null;
    loadRequestedForRef.current = null;
    handledAwaitingFocusedViewRef.current = null;
    if (jumpFallbackTimeoutRef.current !== null) {
      clearTimeout(jumpFallbackTimeoutRef.current);
      jumpFallbackTimeoutRef.current = null;
    }
  }
  useEffect(() => {
    if (!jumpToEventId || !room) return;
    // Review fix: keyed by room *and* event, not event alone — if the user
    // starts a jump in one room then manually switches away before it
    // resolves, an event-id-only key would keep matching in every other
    // room the user visits afterward (since `jumpToEventId` itself isn't
    // cleared by a plain room switch), permanently blocking any new jump
    // request until the original room is reopened.
    const requestKey = `${room.room_id}:${jumpToEventId}`;
    const index = messages.findIndex((m) => m.event_id === jumpToEventId);
    if (index >= 0) {
      handleJumpToMessage(jumpToEventId);
      // Review fix: if a `loadTimelineAroundEvent` call is still in flight
      // for this exact jump (its own focused-timeline listener beat the
      // IPC promise to emitting this update), remember that so the
      // `.then()` below can still apply `installed_focused_view` once it
      // resolves — everything else about this jump (scroll,
      // `onJumpHandled`) is already handled right here.
      if (loadRequestedForRef.current === requestKey) {
        handledAwaitingFocusedViewRef.current = requestKey;
      }
      loadRequestedForRef.current = null;
      // The normal path landed — cancel any fallback still pending from
      // this same jump so it can't later force-clear a subsequent one.
      if (jumpFallbackTimeoutRef.current !== null) {
        clearTimeout(jumpFallbackTimeoutRef.current);
        jumpFallbackTimeoutRef.current = null;
      }
      onJumpHandled?.();
      return;
    }
    // Waits for this room's own initial load to genuinely finish
    // (`hasStartedLoadingRoomIdRef` — same "readyToSeed" gate the
    // entrance-animation/unread-divider logic above already uses) before
    // falling back to `loadTimelineAroundEvent`. `loading`'s own initial
    // value is `false` before `useChatTimeline`'s fetch effect has even run
    // (see this file's other uses of `hasStartedLoadingRoomIdRef` for the
    // same caveat) — a plain `!loading` check would otherwise treat that
    // premature render as "settled, and the event isn't here" and fire a
    // redundant load-around request for a bookmark that's actually part of
    // this very first page.
    const initialLoadSettled = !loading && hasStartedLoadingRoomIdRef.current === activeRoomId;
    if (!initialLoadSettled) return;
    if (loadRequestedForRef.current === requestKey) return;
    loadRequestedForRef.current = requestKey;
    loadTimelineAroundEvent(room.room_id, jumpToEventId)
      .then(({ found, installed_focused_view }) => {
        // Review fix: the already-loaded branch above can fire for this
        // exact request before this promise resolves (its own
        // focused-timeline listener emitted the update first) — in that
        // case it already cleared `loadRequestedForRef` and handled the
        // scroll/`onJumpHandled`, but left `installed_focused_view` for
        // this callback to still apply, tracked via
        // `handledAwaitingFocusedViewRef`. Apply it and stop — everything
        // else about this jump is already done.
        if (handledAwaitingFocusedViewRef.current === requestKey) {
          handledAwaitingFocusedViewRef.current = null;
          if (installed_focused_view) {
            mightHaveFocusedViewRef.current = true;
            setHasFocusedView(true);
          }
          return;
        }
        // Only act on this request if it's still the current one — cleared
        // (to `null`) the moment the already-loaded branch above fires for
        // this same jump, which can still happen before this promise
        // resolves. Without this check, an already-handled jump could
        // double-call `onJumpHandled` once this stale promise finally
        // settles.
        if (loadRequestedForRef.current !== requestKey) return;
        if (installed_focused_view) {
          mightHaveFocusedViewRef.current = true;
          setHasFocusedView(true);
        }
        // A `false` result means the event isn't reachable at all (further
        // back than the pagination cap, or no longer in this room's
        // history) — nothing more to try, so give up rather than leaving
        // the caller's `jumpToEventId` set forever. Also reset the ref: left
        // set to this key, the dedup check above would permanently block a
        // retry of the exact same jump (e.g. the caller re-sets the same
        // `jumpToEventId` after the panel is reopened) even though this
        // attempt is now finished.
        if (!found) {
          loadRequestedForRef.current = null;
          onJumpHandled?.();
          return;
        }
        // A `true` result doesn't call `onJumpHandled` here directly: the
        // `timeline:update` triggered by that pagination normally lands in
        // `messages` and re-runs this effect, which then takes the
        // already-loaded branch above (scrolling to the message *and*
        // clearing the jump together).
        //
        // Review fix: if that update is ever missed or dropped, nothing
        // else would clear `jumpToEventId` — the effect's dedup key
        // (`loadRequestedForRef`) already matches this request, so it would
        // never re-issue `loadTimelineAroundEvent` either, leaving the jump
        // permanently "in progress" and the Saved Messages entry stuck
        // showing as unresolved. This fallback timer gives the normal path
        // a window to land first (preserving the scroll-to-message
        // behavior in the common case), and only force-clears the jump —
        // without a scroll — if it hasn't.
        if (jumpFallbackTimeoutRef.current !== null) {
          clearTimeout(jumpFallbackTimeoutRef.current);
        }
        jumpFallbackTimeoutRef.current = setTimeout(() => {
          jumpFallbackTimeoutRef.current = null;
          if (loadRequestedForRef.current === requestKey) {
            loadRequestedForRef.current = null;
            onJumpHandled?.();
          }
        }, JUMP_FALLBACK_TIMEOUT_MS);
      })
      .catch((err) => {
        // Same "is this still the current request" guard as the `.then()`
        // branch above — review fix: an earlier request's rejection must
        // not clear a *newer* jump the user has since started (e.g.
        // reopened Settings and picked a different bookmark while this one
        // was still failing/pagination-erroring). Only the request whose
        // key still matches this ref gets to reset it and notify the caller.
        if (loadRequestedForRef.current === requestKey) {
          // Also clear the caller's own jump target here (review fix) —
          // otherwise `RoomsScreen` keeps the stale `jumpToEventId` set,
          // and since mutating this ref alone doesn't trigger a re-render,
          // a later room selection could still see this same value
          // re-attempted against an unrelated room.
          loadRequestedForRef.current = null;
          onJumpHandled?.();
        }
        logAndIgnore(err);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToEventId, room?.room_id, messages, loading, activeRoomId]);
  // Review fix: only clears the fallback timer on unmount, not on every
  // dependency change of the effect above — the fallback timer is the *only*
  // thing that will ever call `onJumpHandled` for a request whose
  // `timeline:update` never lands, so clearing it whenever `messages`/
  // `loading` change (as a cleanup returned from that effect itself would)
  // would leave a jump permanently "in progress" instead of just avoiding a
  // stale callback into an unmounted component.
  useEffect(() => {
    return () => {
      if (jumpFallbackTimeoutRef.current !== null) {
        clearTimeout(jumpFallbackTimeoutRef.current);
        jumpFallbackTimeoutRef.current = null;
      }
    };
  }, []);
  // The memo callback below is pure — no ref mutation inside it. `React.
  // StrictMode` (see `src/main.tsx`) double-invokes memo callbacks for the
  // same commit; mutating `seenRowKeysRef`/`seededRoomIdRef` *inside this
  // memo* would make the second invocation see state already consumed by
  // the first, silently returning an empty `fresh` set for a message that
  // should have animated. (The plain assignments above and in the paired
  // `useEffect` below are fine under double-invocation — they're
  // unconditional/idempotent, not reads of this memo's own prior output —
  // it's specifically conditional mutation from inside the memo body that's
  // unsafe.) The consuming writes that depend on this render's `fresh` diff
  // (marking rows seen) happen in the `useEffect` below, which — sharing
  // this memo's exact dependency list — fires exactly once per committed
  // `messages`/`loading`/`loadingMore`/`activeRoomId`/`prependedCount`/
  // `hasMore`/`paginationError` change, not on every incidental re-render.
  // The last two are read only indirectly, via `awaitingEmptyPagePagination`
  // (declared above) — without them in the dependency list, a
  // `paginationError`/`hasMore` transition landing in a commit that doesn't
  // also change one of the other tracked values would leave this memo
  // returning its previous (possibly `readyToSeed`-gated-empty) cached Set.
  //
  // Excludes the first `prependedCount` entries — `useChatTimeline`'s own
  // identity-based prepend detection (see `applyMessages`), not a coarse
  // "was any pagination request in flight" flag. That coarser approach (an
  // earlier version of this file, keyed on a `firstItemIndex` diff computed
  // here) blanket-suppressed the *entire* update whenever `loadingMore` had
  // been true, which also wrongly suppressed a genuinely new live message
  // appended to the tail if it happened to race an in-flight
  // `loadMoreHistory` request. A plain `firstItemIndex` diff has its own bug
  // too: if an update both prepends history *and* drops one or more old
  // front rows in the same snapshot (e.g. an `UnableToDecrypt` placeholder
  // resolving into a filtered-out type), the diff is only the *net* shift,
  // under-counting how many leading rows are genuinely prepended history.
  // `prependedCount` is `useChatTimeline`'s own `newIndex` — the boundary
  // between new content and the surviving anchor — which isn't affected by
  // that.
  const newMessageKeys = useMemo(() => {
    const readyToSeed =
      !loading &&
      hasStartedLoadingRoomIdRef.current === activeRoomId &&
      !awaitingEmptyPagePagination;
    if (!readyToSeed) return new Set<string>();
    if (seededRoomIdRef.current !== activeRoomId) return new Set<string>();
    const fresh = new Set<string>();
    messages.forEach((m, i) => {
      if (i < prependedCount) return;
      const key = messageRowKey(m);
      if (seenRowKeysRef.current.has(key)) return;
      if (m.sender === currentUserId && seenOwnTimestampsRef.current.has(m.timestamp_ms)) return;
      fresh.add(key);
    });
    return fresh;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, loading, loadingMore, activeRoomId, prependedCount, hasMore, paginationError]);
  useEffect(() => {
    const readyToSeed =
      !loading &&
      hasStartedLoadingRoomIdRef.current === activeRoomId &&
      !awaitingEmptyPagePagination;
    if (!readyToSeed) return;
    if (seededRoomIdRef.current !== activeRoomId) {
      seededRoomIdRef.current = activeRoomId;
      seenRowKeysRef.current = new Set(messages.map(messageRowKey));
      seenOwnTimestampsRef.current = new Set(
        messages.filter((m) => m.sender === currentUserId).map((m) => m.timestamp_ms),
      );
      return;
    }
    // "Jump to present" pill (Spec 26 Phase 2): counts `newMessageKeys` (the
    // same genuinely-new-arrival diff the entrance animation uses — see the
    // state declaration above for why this no longer excludes the current
    // user's own messages) into `newMessageCount`, but *only inside this
    // effect* — which fires exactly once per real `messages` update —
    // reading `atBottomRef.current` at that exact moment, not as a
    // dependency. An earlier version depended on `[newMessageKeys, atBottom]`
    // directly: `newMessageKeys` is a `useMemo` that returns the *same*
    // memoized Set across renders where `messages`/`loading`/`loadingMore`/
    // `activeRoomId`/`prependedCount`/`hasMore`/`paginationError` didn't
    // change, so merely scrolling away
    // from bottom (changing only `atBottom`) re-ran that effect against the
    // same stale Set and double-counted messages that had already arrived
    // while at bottom. Gating on the ref instead of a dependency means this
    // only ever evaluates once per actual data change, with whatever
    // `atBottom` was true at that moment. Reset to 0 happens in
    // `handleVirtuosoAtBottomStateChange`/`handleJumpToPresent`/the
    // room-change effect above, not here.
    if (!atBottomRef.current && newMessageKeys.size > 0) {
      setNewMessageCount((count) => count + newMessageKeys.size);
    }
    messages.forEach((m) => {
      seenRowKeysRef.current.add(messageRowKey(m));
      if (m.sender === currentUserId) seenOwnTimestampsRef.current.add(m.timestamp_ms);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, loading, loadingMore, activeRoomId, prependedCount, hasMore, paginationError]);
  // The "New messages" divider's position is frozen at the *identity* of
  // the first unread message as of opening this room — not re-derived from
  // live `messages.length` on every render. `useChatTimeline` marks the
  // room read as soon as it becomes active, which asynchronously drives the
  // room's unread count back to 0 via a later `room_list:update`, so using
  // a live count/index would make the divider flash in and immediately
  // disappear (or, worse, silently drift forward) instead of staying put
  // above the same message until the user switches rooms. Freezing by
  // message key (not a frozen index recomputed against a growing array)
  // also survives new messages appending and older history prepending via
  // backward pagination — both change every live index without changing
  // which message was first unread.
  //
  // Uses `room.unread_messages` (ambient unread message count), not
  // `room.unread_count` (notifications/mentions only, per RoomSummary's own
  // doc comment) — a room can have unread messages with zero notifications,
  // or a mention buried mid-page, and `unread_count` reflects neither
  // correctly for "where does the unread history start".
  //
  // Seeding waits for a `loading` transition (via
  // hasStartedLoadingRoomIdRef), not just "loading currently reads false":
  // `useChatTimeline`'s `loading` state starts at `false` before its fetch
  // effect has run, so seeding on that premature render would freeze the
  // boundary against a stale/empty message snapshot.
  const unreadBoundaryKeyRef = useRef<string | null>(null);
  const seededUnreadRoomIdRef = useRef<string | null>(null);
  if (
    !loading &&
    hasStartedLoadingRoomIdRef.current === activeRoomId &&
    !awaitingEmptyPagePagination &&
    seededUnreadRoomIdRef.current !== activeRoomId
  ) {
    seededUnreadRoomIdRef.current = activeRoomId;
    const unreadCount = room?.unread_messages ?? 0;
    const boundaryIdx = unreadDividerIndex(messages.length, unreadCount);
    const boundaryMessage = boundaryIdx >= 0 ? messages[boundaryIdx] : undefined;
    unreadBoundaryKeyRef.current = boundaryMessage ? messageRowKey(boundaryMessage) : null;
  }
  const unreadStartIdx = unreadBoundaryKeyRef.current
    ? messages.findIndex((m) => messageRowKey(m) === unreadBoundaryKeyRef.current)
    : -1;
  // A date divider or the frozen unread divider breaks a consecutive-sender
  // run, even when the surrounding messages are literally from the same
  // sender — otherwise the message right after the divider renders without
  // its own avatar/name (looking like a continuation of the group above the
  // divider), and the message right before it can lose its timestamp.
  function isGroupBreakAt(index: number): boolean {
    return isDateDividerBoundary(messages, index) || index === unreadStartIdx;
  }
  // Memoized, not a plain `.map()`, because `useCanRedactMap` uses this as
  // a `useMemo` dependency — a fresh array every render would defeat that
  // memoization entirely (Sentry review on #287, LOW).
  const senders = useMemo(() => messages.map((m) => m.sender), [messages]);
  // Best-effort display-name lookup for read-receipt tooltips ("Read by
  // {name}") — built from senders already present in the loaded timeline
  // rather than a dedicated member-list fetch, since a reader is virtually
  // always someone who has also sent a message in view. Falls back to the
  // bare user id in MessageRow when a reader hasn't sent anything loaded.
  const senderNameByUserId = new Map<string, string>();
  for (const m of messages) {
    if (m.sender_display_name != null) senderNameByUserId.set(m.sender, m.sender_display_name);
  }
  const canRedactBySender = useCanRedactMap(roomId, currentUserId, senders);
  const { receiptsByEvent } = useReadReceipts(room?.room_id ?? null, currentUserId);
  const headerPresence = usePresence(room?.is_direct ? (room.dm_peer_user_id ?? null) : null);
  const { typingText, handleTypingInput, stopTyping } = useChatTyping(activeRoomId, currentUserId);
  const participants = useRoomParticipants(activeRoomId, currentUserId);
  useEffect(() => {
    setFollowingExpanded(false);
  }, [activeRoomId]);
  const { uploads, handleAttachFile, dismissUpload } = useAttachmentUploads(activeRoomId);
  const { commandFeedback, setCommandFeedback, handleComposerSubmit, handleSlashCommand } =
    useMessageSend({
      room,
      editingEventId,
      replyTarget,
      setEditingEventId,
      setReplyTarget,
      stopTyping,
    });
  const {
    handleToggleReaction,
    handleDelete,
    handleReply,
    handleEdit,
    handleResend,
    handleDiscard,
    handleBookmark,
    handleUnbookmark,
    bookmarkedEventIds,
  } = useMessageActions({
    roomId: activeRoomId,
    setReplyTarget,
    setEditingEventId,
  });

  // No `send_queue:update` listener here: the live `Timeline` (Spec 14)
  // surfaces the same pending -> sent -> error transitions as `send_state` on
  // the `RoomMessageSummary`s pushed via `timeline:update` above, so a
  // separate room-wide send-queue event would just be redundant for the
  // message list.

  if (!room) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select a room to start chatting
      </div>
    );
  }

  const editingMessage = messages.find((m) => m.event_id === editingEventId) ?? null;
  const composerMode: ComposerMode = editingEventId ? "edit" : replyTarget ? "reply" : "send";

  // Sending (or replying) always scrolls to the user's own new message,
  // regardless of prior scroll position — `followOutput="auto"` alone won't
  // do this, since Virtuoso only follows new content while already
  // considered at bottom, and the "jump to present" pill deliberately
  // excludes the user's own messages from its count (sending is already an
  // intentional "return to present" action). Without this, sending while
  // scrolled up would leave the just-sent message offscreen with no visible
  // way back to it.
  function scrollToPresentAfterOwnSend() {
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end" });
    handleVirtuosoAtBottomStateChange(true);
  }
  // Skipped for edits: saving an edit to an old message shouldn't relocate
  // the view to it. Gated on `handleComposerSubmit`'s own success signal —
  // if the queueing call itself rejected (network/validation error) before
  // any local echo was created, there's no new message to scroll to.
  async function handleComposerSubmitAndScroll(
    content: Parameters<typeof handleComposerSubmit>[0],
  ) {
    const wasEditing = composerMode === "edit";
    const succeeded = await handleComposerSubmit(content);
    if (!wasEditing && succeeded) scrollToPresentAfterOwnSend();
  }
  // A slash command (e.g. `/me ...`, which sends an emote message the same
  // way a plain send does — see `src-tauri/src/matrix/commands.rs`) goes
  // through this separate path, not `onSubmit` — the same "scroll to the
  // user's own new message" gap applies here and was missed by the fix
  // above. Gated on both `parsed.command === "me"` *and* the command
  // actually succeeding: most slash commands (`/topic`, `/invite`, `/kick`,
  // `/ban`, ...) never append a `RoomMessageSummary` even on success, and a
  // failed `/me` (bad args, no permission) doesn't either — scrolling
  // unconditionally would yank the user to the bottom (and mark them
  // at-bottom/read) for a command that sent nothing.
  async function handleSlashCommandAndScroll(parsed: Parameters<typeof handleSlashCommand>[0]) {
    const succeeded = await handleSlashCommand(parsed);
    if (parsed.command === "me" && succeeded) scrollToPresentAfterOwnSend();
  }

  async function handleAttachClick() {
    if (isWebBuild()) {
      attachmentInputRef.current?.click();
      return;
    }
    const selected = await openFileDialog({ multiple: false });
    if (typeof selected === "string") {
      await handleAttachFile(selected);
    }
  }

  function handleAttachmentInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) {
      handleAttachFile(file);
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (fileDragLeaveTimerRef.current !== null) {
      clearTimeout(fileDragLeaveTimerRef.current);
      fileDragLeaveTimerRef.current = null;
    }
    setFileDragActive(false);
    const files = Array.from(event.dataTransfer.files) as (File & { path?: string })[];
    const file = files[0];
    const upload = file ? attachmentUploadPayload(file) : null;
    if (upload) {
      handleAttachFile(upload);
    }
  }

  function handleDragEnter(event: React.DragEvent<HTMLDivElement>) {
    if (!mediaSendPolishEnabled || !hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (fileDragLeaveTimerRef.current !== null) {
      clearTimeout(fileDragLeaveTimerRef.current);
      fileDragLeaveTimerRef.current = null;
    }
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    setFileDragActive(true);
  }

  function handleDragOver(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (hasDraggedFiles(event.dataTransfer)) event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: React.DragEvent<HTMLDivElement>) {
    if (!mediaSendPolishEnabled) return;
    event.preventDefault();
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;

    // A few webviews omit `relatedTarget` for child-to-child transitions. Delay
    // clearing by one task so the matching `dragenter` can cancel it without a
    // one-frame overlay flicker.
    if (fileDragLeaveTimerRef.current !== null) clearTimeout(fileDragLeaveTimerRef.current);
    fileDragLeaveTimerRef.current = setTimeout(() => {
      fileDragLeaveTimerRef.current = null;
      setFileDragActive(false);
    }, 0);
  }

  function handlePaste(event: React.ClipboardEvent<HTMLDivElement>) {
    const files = Array.from(event.clipboardData.files) as (File & { path?: string })[];
    const file = files.find((f) => f.type.startsWith("image/"));
    const upload = file ? attachmentUploadPayload(file) : null;
    if (upload) {
      event.preventDefault();
      handleAttachFile(upload);
    }
  }

  return (
    <div
      data-testid="chat-shell"
      className="relative flex min-w-0 flex-1 flex-col"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {mediaSendPolishEnabled && fileDragActive && (
        <output
          aria-live="polite"
          className="pointer-events-none absolute inset-3 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-primary-solid bg-background/90 text-center shadow-lg backdrop-blur-sm"
        >
          <div className="flex flex-col items-center gap-2 px-6 text-foreground">
            <Paperclip className="size-8 text-primary" />
            <span className="text-base font-semibold">
              Drop files in {displayName(room.room_id, room.name)}
            </span>
            <span className="text-sm text-muted-foreground">Release to upload</span>
          </div>
        </output>
      )}
      <div
        className={cn(
          "flex items-center justify-between border-b border-border",
          mobile ? "h-14 gap-1 px-1.5" : "gap-2 p-4",
        )}
      >
        {mobile && (
          <button
            type="button"
            aria-label="Back to chats"
            onClick={onBack}
            className="flex size-11 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-accent"
          >
            <ArrowLeft className="size-5" />
          </button>
        )}
        <div className="flex min-w-0 items-center gap-2 text-[15px] font-bold text-foreground">
          <Avatar size="sm">
            <AvatarImage src={resolveAvatar(room.avatar_path, room.avatar_url)} alt="" />
            <AvatarFallback
              style={{ background: avatarColor(room.room_id) }}
              className="font-bold text-white"
            >
              {initials(room.room_id, room.name)}
            </AvatarFallback>
            {room.is_direct && (
              <PresenceDot
                presence={headerPresence?.presence}
                statusMsg={headerPresence?.status_msg}
                lastActiveAgoMs={headerPresence?.last_active_ago_ms}
              />
            )}
          </Avatar>
          <span className="truncate">{displayName(room.room_id, room.name)}</span>
        </div>
        {mobile ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Room actions"
                className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                <MoreVertical className="size-5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem
                className="min-h-11"
                onSelect={() => setMembersDrawerOpen((open) => !open)}
              >
                <Info />
                {membersDrawerOpen ? "Hide members" : "Show members"}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="min-h-11"
                onSelect={() => setRoomSettingsTarget({ roomId: room.room_id, section: "general" })}
              >
                <Settings />
                Room settings
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label={membersDrawerOpen ? "Hide members" : "Show members"}
              aria-pressed={membersDrawerOpen}
              onClick={() => setMembersDrawerOpen((open) => !open)}
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                membersDrawerOpen && "bg-accent text-accent-foreground",
              )}
            >
              <Info className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Room settings"
              onClick={() => setRoomSettingsTarget({ roomId: room.room_id, section: "general" })}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <Settings className="size-4" />
            </button>
          </div>
        )}
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* While `messages` is empty but `hasMore` is true (and no request
            has failed), older pages are being auto-fetched (see the effect
            above) looking for a renderable message — keep showing the
            loading state rather than "No messages yet", which would
            otherwise flash misleadingly for a room whose *newest* page
            happened to be entirely unsupported item types. */}
        {(loading || (messages.length === 0 && hasMore && !paginationError)) && (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        )}
        {!loading && messages.length === 0 && !hasMore && mobile && (
          <div className="flex flex-1 items-center justify-center px-6 text-center">
            <div className="flex max-w-xs flex-col items-center">
              <span className="mb-3 flex size-12 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                <MessageCircle className="size-6" aria-hidden="true" />
              </span>
              <p className="text-sm font-semibold text-foreground">No messages yet</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Send the first message to start the conversation.
              </p>
            </div>
          </div>
        )}
        {!loading && messages.length === 0 && !hasMore && !mobile && (
          <p className="p-4 text-sm text-muted-foreground">No messages yet</p>
        )}
        {!loading && messages.length === 0 && hasMore && paginationError && (
          <p className="p-4 text-sm text-muted-foreground">Couldn't load messages</p>
        )}
        {!loading && messages.length > 0 && (
          <Virtuoso
            // Remounts (and so resets Virtuoso's internal scroll/measurement
            // state, including `firstItemIndex`) on every room switch —
            // simpler and more robust than manually resetting each piece of
            // that state ourselves, and matches `useChatTimeline`'s own
            // per-room reset of `firstItemIndex`.
            key={room.room_id}
            ref={virtuosoRef}
            // `flex-1` (not just padding): the old scroller was itself the
            // `flex-1 overflow-y-auto` child of this `min-h-0 flex-1`
            // container. Without it, Virtuoso's root has no bounded height
            // to size its internal scroll area against — in a room with
            // enough messages to scroll, it grows to fit its own content
            // instead of owning the remaining chat pane, breaking viewport
            // measurement and potentially pushing the composer offscreen.
            className="flex-1 p-4"
            data={messages}
            firstItemIndex={firstItemIndex}
            initialTopMostItemIndex={messages.length - 1}
            alignToBottom
            followOutput="auto"
            startReached={loadMoreHistory}
            atBottomStateChange={handleVirtuosoAtBottomStateChange}
            context={{ loadingMore, hasMore }}
            components={{ Header: LoadingOlderHeader }}
            // Without this, Virtuoso keys rendered rows by their current
            // position, not identity. A full `timeline:update` snapshot can
            // remove an item from the *middle* of `messages` (not just
            // append/prepend) — e.g. an `UnableToDecrypt` placeholder
            // resolving into a msgtype `RoomMessageSummary` filters out
            // entirely — which shifts every later message's index by one.
            // Index-keyed rows would then have every later message inherit
            // the previous row's React state and Virtuoso's per-row
            // measurement cache: open action menus, measured heights, and
            // row-local UI state could all end up attached to the wrong
            // message.
            computeItemKey={(_index, message) => messageRowKey(message)}
            itemContent={(index, message) => {
              const i = index - firstItemIndex;
              const own = message.sender === currentUserId;
              const prev = messages[i - 1];
              const next = messages[i + 1];
              // Own messages are always redactable — don't wait on the async
              // `canRedactBySender` resolution (which only matters for other
              // senders' power levels) or Delete flashes hidden-then-shown.
              const allowedToRedact = own || (canRedactBySender[message.sender] ?? false);
              const readers = receiptsByEvent.get(message.event_id) ?? [];

              return (
                // `flex flex-col` (not a plain block `div`): Virtuoso measures
                // this wrapper's own box to estimate/settle row height, but
                // `BubbleMessageRow`/`DiscordMessageRow` put their grouping
                // spacing on the row root as a top *margin* (`mt-3`/`mt-0.5`),
                // which a plain block parent with no padding/border lets
                // collapse through its own top edge — Virtuoso would then
                // under-measure the row by exactly that margin, breaking
                // bottom-detection and prepend-anchoring math. A flex
                // container's children never margin-collapse with it (they
                // participate in the flex formatting context, not the block
                // one), so this fully contains the row's true rendered height
                // with no visual change (still a single child either way).
                <div className="flex flex-col pb-1">
                  {isDateDividerBoundary(messages, i) && (
                    <div className="my-2 flex items-center gap-3 text-xs font-semibold text-muted-foreground">
                      {formatDateDividerLabel(message.timestamp_ms)}
                    </div>
                  )}
                  {i === unreadStartIdx && (
                    <div className="my-2 flex items-center gap-2">
                      <div className="h-px flex-1 bg-destructive-solid" />
                      <span className="text-[11px] font-semibold text-destructive-solid">
                        New messages
                      </span>
                      <div className="h-px flex-1 bg-destructive-solid" />
                    </div>
                  )}
                  <MessageRow
                    message={message}
                    roomId={room.room_id}
                    currentUserId={currentUserId}
                    own={own}
                    sameSenderAsPrev={prev?.sender === message.sender && !isGroupBreakAt(i)}
                    sameSenderAsNext={next?.sender === message.sender && !isGroupBreakAt(i + 1)}
                    canRedact={allowedToRedact}
                    readers={readers}
                    senderNameByUserId={senderNameByUserId}
                    // Excludes `own` messages: `messageRowKey` (transaction_id ??
                    // event_id) isn't stable across the local-echo -> ack
                    // transition for a message *we* sent — `transaction_id()`
                    // only returns `Some` while an item is still local (see
                    // `timeline.rs`'s `build_message_summary`), so the row's key
                    // itself changes once the homeserver ack replaces the local
                    // echo. That makes the acked row look "unseen" and replay the
                    // entrance animation a second time. Other senders' messages
                    // have no local-echo phase to begin with, so this exclusion
                    // only ever skips the case that would otherwise double-animate.
                    isNew={!own && newMessageKeys.has(messageRowKey(message))}
                    getActionsHandle={(key) => actionsRefs.current.get(key)}
                    registerActionsRef={(key, el) => {
                      if (el) actionsRefs.current.set(key, el);
                      else actionsRefs.current.delete(key);
                    }}
                    onReply={() => handleReply(message)}
                    onReact={(emoji) => handleToggleReaction(message.event_id, emoji)}
                    onEdit={() => handleEdit(message.event_id)}
                    onDelete={() => {
                      if (messageActionParityEnabled) {
                        setRedactionTargetEventId(message.event_id);
                      } else {
                        void handleDelete(message.event_id);
                      }
                    }}
                    onCopy={() => navigator.clipboard?.writeText(message.body)}
                    onResend={() => {
                      if (message.transaction_id) void handleResend(message.transaction_id);
                    }}
                    onDiscard={() => {
                      if (message.transaction_id) void handleDiscard(message.transaction_id);
                    }}
                    onCopyLink={() => {
                      if (!navigator.clipboard?.writeText || !permalinkViaServer) return;
                      navigator.clipboard
                        .writeText(
                          eventPermalink(room.room_id, message.event_id, permalinkViaServer),
                        )
                        .catch(logAndIgnore);
                    }}
                    onJumpToMessage={handleJumpToMessage}
                    onUserPillClick={(userId, label) => setPillProfile({ userId, label })}
                    onRoomPillClick={onNavigateToRoom}
                    // Bookmarks (Spec 12) have no local per-account store on
                    // the web build — omitting these entirely (rather than
                    // wiring them to a no-op) hides the menu item, same
                    // pattern as `SettingsScreen`'s `webUnsupported` sections.
                    onBookmark={isWebBuild() ? undefined : () => handleBookmark(message.event_id)}
                    onUnbookmark={
                      isWebBuild() ? undefined : () => handleUnbookmark(message.event_id)
                    }
                    isBookmarked={bookmarkedEventIds.has(message.event_id)}
                  />
                </div>
              );
            }}
          />
        )}
        {/* "Jump to present" (Spec 26 Phase 2): shown while scrolled away
            from the live bottom with at least one new (non-own) message
            arrived since — never while already at bottom, the Charm 1.0
            #328 failure mode this migration is meant to avoid.
            Review fix: also shown whenever `hasFocusedView` is set,
            regardless of `newMessageCount` — a focused (`TimelineFocus::Event`)
            view from a Saved Messages jump never receives live updates, so
            `newMessageCount` would otherwise stay 0 forever after such a
            jump, leaving the user with no in-room way to reset back to
            live short of leaving and reopening the room. */}
        {(hasFocusedView || (!atBottom && newMessageCount > 0)) && (
          <button
            type="button"
            onClick={handleJumpToPresent}
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary-solid px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-md hover:opacity-90"
          >
            {newMessageCount > 0
              ? `${newMessageCount} new message${newMessageCount === 1 ? "" : "s"}`
              : "Jump to present"}
            <ChevronDown className="size-3.5" />
          </button>
        )}
      </div>

      <ConfirmWithReasonDialog
        open={redactionTargetEventId !== null}
        title="Delete message?"
        description="This removes the message for everyone in the room and cannot be undone."
        confirmLabel="Delete message"
        submittingLabel="Deleting…"
        reasonDescription="The reason is sent to your homeserver and may be visible to other room clients."
        onOpenChange={(open) => {
          if (!open) setRedactionTargetEventId(null);
        }}
        onConfirm={(reason) =>
          redactionTargetEventId
            ? handleDelete(redactionTargetEventId, reason)
            : Promise.resolve(false)
        }
      />

      {typingText && (
        <output className="flex items-center gap-2 px-4 pb-1 text-xs font-medium text-muted-foreground">
          <span className="flex items-center gap-[3px]" aria-hidden="true">
            <span
              className="typing-dot size-[5px] rounded-full bg-muted-foreground"
              style={{ animationDelay: "0s" }}
            />
            <span
              className="typing-dot size-[5px] rounded-full bg-muted-foreground"
              style={{ animationDelay: "0.2s" }}
            />
            <span
              className="typing-dot size-[5px] rounded-full bg-muted-foreground"
              style={{ animationDelay: "0.4s" }}
            />
          </span>
          <span>{typingText}</span>
        </output>
      )}

      <UploadTray uploads={uploads} onDismiss={dismissUpload} />

      {replyTarget && !editingEventId && (
        <div className="px-3 pb-1">
          <ReplyPreview
            reply={replyTarget}
            variant="composer"
            onCancel={() => setReplyTarget(null)}
          />
        </div>
      )}
      {editingMessage && (
        <div className="px-3 pb-1">
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-secondary px-3 py-2 text-sm">
            <span className="text-xs font-semibold text-secondary-foreground">Editing message</span>
            <button
              type="button"
              aria-label="Cancel edit"
              onClick={() => setEditingEventId(null)}
              className="text-xs text-muted-foreground hover:underline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {commandFeedback && (
        <div className="px-3 pb-1">
          <output className="flex items-center justify-between gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
            {commandFeedback}
            <button
              type="button"
              aria-label="Dismiss command feedback"
              onClick={() => setCommandFeedback(null)}
              className="shrink-0"
            >
              <X size={14} />
            </button>
          </output>
        </div>
      )}

      {mobile && participants.length > 0 && (
        <button
          type="button"
          aria-expanded={followingExpanded}
          onClick={() => setFollowingExpanded((expanded) => !expanded)}
          className="w-full border-t border-border px-4 py-2 text-left text-xs text-muted-foreground hover:bg-accent/50"
        >
          {followingLabel(participants.map((p) => p.display_name ?? p.user_id))}
          {followingExpanded && (
            <div className="mt-1.5 flex flex-col gap-1">
              {participants.map((p) => (
                <span key={p.user_id} className="flex items-center gap-2 text-foreground">
                  <span
                    className="flex size-4 shrink-0 items-center justify-center rounded-full text-[7px] font-bold text-white"
                    style={{ background: avatarColor(p.user_id) }}
                  >
                    {initials(p.user_id, p.display_name)}
                  </span>
                  {p.display_name ?? p.user_id}
                </span>
              ))}
            </div>
          )}
        </button>
      )}
      <div
        data-testid="composer-shell"
        className={cn(
          "pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
          mobile ? "px-2" : "px-3",
        )}
      >
        <input
          ref={attachmentInputRef}
          type="file"
          className="hidden"
          onChange={handleAttachmentInputChange}
        />
        <div
          className={cn(
            "flex items-end border border-border bg-card",
            mobile ? "gap-1 rounded-2xl p-1" : "gap-2 rounded-lg p-2",
          )}
          onPaste={handlePaste}
        >
          <button
            aria-label="Attach"
            onClick={handleAttachClick}
            className={cn(
              "flex shrink-0 items-center justify-center text-muted-foreground hover:bg-accent disabled:cursor-not-allowed",
              mobile ? "size-11 rounded-full" : "size-9 rounded-md",
            )}
          >
            <Paperclip size={18} />
          </button>
          <Composer
            key={`${room.room_id}-${editingEventId ?? "new"}`}
            ref={composerRef}
            roomId={room.room_id}
            mode={composerMode}
            initialHtml={
              editingMessage
                ? editingMessage.formatted_body
                  ? sanitizeMatrixHtml(editingMessage.formatted_body)
                  : escapeHtmlText(editingMessage.body)
                : undefined
            }
            placeholder={mobile ? "Message" : `Message ${displayName(room.room_id, room.name)}`}
            onSubmit={handleComposerSubmitAndScroll}
            onSlashCommand={handleSlashCommandAndScroll}
            onEscape={() => {
              if (editingEventId) setEditingEventId(null);
              else if (replyTarget) setReplyTarget(null);
            }}
            onTypingInput={handleTypingInput}
            onBlur={stopTyping}
            onEmptyChange={setIsComposerEmpty}
            showFormattingToolbar={!mobile || showMobileFormatting}
          />
          {mobile && (
            <button
              type="button"
              aria-label={showMobileFormatting ? "Hide formatting" : "Show formatting"}
              aria-pressed={showMobileFormatting}
              onClick={() => setShowMobileFormatting((visible) => !visible)}
              className={cn(
                "flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent",
                showMobileFormatting && "bg-accent text-accent-foreground",
              )}
            >
              <Type className="size-5" />
            </button>
          )}
          {/* `bg-primary-solid` (not `bg-primary`): solid fill under
              near-white text/icon — see button.tsx's comment / tokens.css.
              Disabled while there's no text to send — this composer has no
              attachment concept (files upload/send independently), so
              trimmed text emptiness is the only signal. */}
          <button
            type="button"
            aria-label="Send"
            onClick={() => composerRef.current?.submit()}
            disabled={isComposerEmpty}
            className={cn(
              "flex shrink-0 items-center justify-center bg-primary-solid text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50",
              mobile ? "size-11 rounded-full" : "size-9 rounded-md",
            )}
          >
            <Send size={16} />
          </button>
        </div>
      </div>
      {!mobile && participants.length > 0 && (
        <button
          type="button"
          aria-expanded={followingExpanded}
          onClick={() => setFollowingExpanded((expanded) => !expanded)}
          className="w-full border-t border-border px-4 py-2 text-left text-xs text-muted-foreground hover:bg-accent/50"
        >
          {followingLabel(participants.map((p) => p.display_name ?? p.user_id))}
          {followingExpanded && (
            <div className="mt-1.5 flex flex-col gap-1">
              {participants.map((p) => (
                <span key={p.user_id} className="flex items-center gap-2 text-foreground">
                  <span
                    className="flex size-4 shrink-0 items-center justify-center rounded-full text-[7px] font-bold text-white"
                    style={{ background: avatarColor(p.user_id) }}
                  >
                    {initials(p.user_id, p.display_name)}
                  </span>
                  {p.display_name ?? p.user_id}
                </span>
              ))}
            </div>
          )}
        </button>
      )}
      <MessagePillProfileDialog profile={pillProfile} onClose={() => setPillProfile(null)} />
    </div>
  );
}
