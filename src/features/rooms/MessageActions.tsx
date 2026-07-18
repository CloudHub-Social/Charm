import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  Bookmark,
  BookmarkX,
  Copy,
  FileJson,
  Flag,
  Forward,
  History,
  Link2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Reply,
  RotateCw,
  SmilePlus,
  Trash2,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useFlag } from "@/featureFlags";
import { EmojiPicker } from "./EmojiPicker";
import { useRecentReactions } from "./useRecentReactions";

/** How long a touch must be held before it counts as a long-press. */
const LONG_PRESS_MS = 400;

export interface MessageActionsProps {
  isOwn: boolean;
  canRedact: boolean;
  onReply: () => void;
  onReact: (emoji: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onCopyLink: () => void;
  /**
   * Gates the "Pin"/"Unpin" entry — the power level required for
   * `m.room.pinned_events` (Spec day-2/04), same pattern as `canRedact`.
   * Reuses Spec 07's power-level gating, resolved once by the caller from
   * `RoomDetails.can.set_pinned_events` rather than re-checked per row.
   */
  canPin?: boolean;
  /** Whether this message is currently in the room's pinned-events list. */
  isPinned?: boolean;
  onPin?: () => void;
  onUnpin?: () => void;
  /**
   * Bookmarks/unbookmarks this message (Spec 12: personal, private "saved
   * messages" — purely local, no Matrix event sent, distinct from room
   * pinning). Toggled by `isBookmarked`; not rendered at all when
   * `onBookmark`/`onUnbookmark` are both omitted (the web build, which has
   * no local per-account store for this — see `SettingsScreen`'s
   * `webUnsupported` pattern).
   */
  onBookmark?: () => void;
  onUnbookmark?: () => void;
  isBookmarked?: boolean;
  /**
   * Retries a failed send in place (SDK send-queue retry, not a
   * re-composed re-send). Only rendered when `isError` is set — see that
   * prop's doc comment.
   */
  onResend?: () => void;
  /** Discards a failed send's local echo. Only rendered when `isError` is set. */
  onDiscard?: () => void;
  className?: string;
  /**
   * Set while the message is still a local echo (`send_state.state ===
   * "pending"`) — its event id is a temporary transaction id, not a real
   * server event id, so relation-based actions (reply/react/edit/delete)
   * would fail if attempted against it. Copy stays available since it only
   * needs the body text.
   */
  disableRelationActions?: boolean;
  /**
   * Set when the message's `body` is still the fixed "Unable to decrypt
   * message" placeholder (see `UNABLE_TO_DECRYPT_BODY` in
   * `src-tauri/src/matrix/timeline.rs`) — there's no real content yet to
   * edit, copy, reply to, or react to. Delete/redact stays available: the
   * user can still want a message they can't read gone from the room, and
   * redacting doesn't need the plaintext. If the key later arrives, the
   * timeline emits a fresh diff with real content and this flips back off.
   */
  isUndecrypted?: boolean;
  /**
   * Set while the message's send-queue local echo has failed
   * (`send_state.state === "error"`) — shows Resend/Discard instead of the
   * usual relation actions, since a failed send has no real event to
   * reply/react/edit against (see `disableRelationActions`) and re-sending
   * or discarding it are the only actions that make sense.
   */
  isError?: boolean;
  /** Forwards this message to another room, via `ForwardMessageDialog`. */
  onForward?: () => void;
  /** Opens the raw event JSON in `MessageSourceDialog`. */
  onViewSource?: () => void;
  /** Reports this message to the homeserver's moderators, via `ConfirmWithReasonDialog`. */
  onReport?: () => void;
  /** Whether this message has been edited — gates the "Edit history" entry. */
  isEdited?: boolean;
  /** Opens this message's edit history in `EditHistoryDialog`. Only rendered when `isEdited` is set. */
  onViewEditHistory?: () => void;
}

/** Imperative handle so a parent can drive the long-press-to-open behavior
 * from an element other than this component's own (hover-revealed, and thus
 * hard to discover on touch) trigger buttons — e.g. the whole message bubble. */
export interface MessageActionsHandle {
  startLongPress: () => void;
  cancelLongPress: () => void;
}

/**
 * Per-timeline-item action menu: Reply/React/Edit/Delete/Copy, gated by
 * `isOwn` (Edit is sender-only per spec) and `canRedact` (Delete is gated by
 * the room's redact power level, read by the caller). When `isError` is set
 * (a failed send's local echo), the menu instead offers Resend/Discard in
 * place of Delete — matching `disableRelationActions`, which is already
 * true for a failed send since it never got a real event id. Opens via the trigger
 * button (revealed on hover by the parent bubble's `group` styling) or via a
 * long-press — either directly on this component, or forwarded from a
 * parent-owned element (e.g. the message bubble itself, which is what's
 * actually visible/discoverable on touch, unlike this component's
 * hover-only trigger) via the imperative handle. The trigger and its
 * sibling react-shortcut button are both 44x44px hit targets per the
 * spec's touch-target minimum.
 */
export const MessageActions = forwardRef<MessageActionsHandle, MessageActionsProps>(
  function MessageActions(
    {
      isOwn,
      canRedact,
      onReply,
      onReact,
      onEdit,
      onDelete,
      onCopy,
      onCopyLink,
      canPin = false,
      isPinned = false,
      onPin,
      onUnpin,
      onBookmark,
      onUnbookmark,
      isBookmarked = false,
      onResend,
      onDiscard,
      className,
      disableRelationActions = false,
      isUndecrypted = false,
      isError = false,
      onForward,
      onViewSource,
      onReport,
      isEdited = false,
      onViewEditHistory,
    },
    ref,
  ) {
    const messageActionParityEnabled = useFlag("message_action_parity");
    const bookmarksEnabled = useFlag("bookmarks");
    const [menuOpen, setMenuOpen] = useState(false);
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const { recent, recordReaction } = useRecentReactions();

    function react(emoji: string) {
      recordReaction(emoji);
      onReact(emoji);
    }

    function startLongPress() {
      longPressTimer.current = setTimeout(() => setMenuOpen(true), LONG_PRESS_MS);
    }

    function cancelLongPress() {
      if (longPressTimer.current) {
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }
    }

    useImperativeHandle(ref, () => ({ startLongPress, cancelLongPress }), []);

    // A touch-and-hold that outlives the item (e.g. the message list re-renders
    // out from under it after a `timeline:update`) must not fire `setMenuOpen`
    // on an unmounted component.
    useEffect(() => {
      return () => {
        if (longPressTimer.current) {
          clearTimeout(longPressTimer.current);
        }
      };
    }, []);

    return (
      <div
        className={cn("flex items-center gap-1", className)}
        // stopPropagation: `ChatShell` forwards the same long-press gesture
        // from the whole message row via the imperative handle above, so
        // without this a touch on this component's own area would bubble up
        // and fire `startLongPress` a second time there — overwriting this
        // handler's timer reference (never cleared) with the row handler's,
        // leaving the first timer to fire regardless of how briefly the
        // touch lasted and open the menu on an ordinary tap.
        onTouchStart={(e) => {
          e.stopPropagation();
          startLongPress();
        }}
        onTouchEnd={(e) => {
          e.stopPropagation();
          cancelLongPress();
        }}
        onTouchCancel={(e) => {
          e.stopPropagation();
          cancelLongPress();
        }}
        onTouchMove={(e) => {
          e.stopPropagation();
          cancelLongPress();
        }}
      >
        {messageActionParityEnabled &&
          !disableRelationActions &&
          !isUndecrypted &&
          recent.slice(0, 4).map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React with ${emoji}`}
              onClick={() => react(emoji)}
              className="flex size-11 items-center justify-center rounded-md text-base hover:bg-secondary"
            >
              {emoji}
            </button>
          ))}
        <EmojiPicker onSelect={react}>
          <button
            type="button"
            aria-label="React"
            disabled={disableRelationActions || isUndecrypted}
            className="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary disabled:pointer-events-none disabled:opacity-40"
          >
            <SmilePlus size={16} />
          </button>
        </EmojiPicker>

        <DropdownMenu
          open={menuOpen}
          onOpenChange={(next) => {
            // Issue #226/#231: reopening this trigger (e.g. clicking "More
            // actions" again on an edited message, right after the previous
            // menu was closed by selecting "Edit") is 100% reproducible as a
            // no-op — the pointerdown that opens the menu also bubbles to
            // `document`, where the newly-mounted (modal={false})
            // DismissableLayer's own outside-pointerdown listener — attached
            // synchronously via flushSync as part of the same pointerdown
            // dispatch — treats it as a click "outside" the not-yet-rendered
            // content and immediately closes the menu it just opened.
            //
            // An earlier version of this fix called stopPropagation() on the
            // trigger's pointerdown, but review (#231) correctly flagged that
            // as too broad: it also stops the SAME event from reaching any
            // *other* already-open Radix layer's outside-pointerdown listener
            // (a different row's menu, or the EmojiPicker popover), so those
            // fail to close when this trigger is clicked. Deferring the state
            // update by a macrotask instead lets the pointerdown finish
            // bubbling (and dismiss any other open layer normally) before
            // this menu's own Content/DismissableLayer mounts, so its
            // listener only ever sees pointerdowns that happen afterward.
            // Closing needs no such deferral. Verified via
            // e2e/message-actions.spec.ts's edit-then-reply flow, which
            // failed 5/5 runs before this fix and passes 5/5+ after.
            if (next) {
              setTimeout(() => setMenuOpen(true), 0);
            } else {
              setMenuOpen(false);
            }
          }}
          modal={false}
        >
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More actions"
              className="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
            >
              <MoreHorizontal size={16} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onReply} disabled={disableRelationActions || isUndecrypted}>
              <Reply />
              Reply
            </DropdownMenuItem>
            {isOwn && (
              <DropdownMenuItem
                onSelect={onEdit}
                disabled={disableRelationActions || isUndecrypted}
              >
                <Pencil />
                Edit
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={onCopy} disabled={isUndecrypted}>
              <Copy />
              Copy
            </DropdownMenuItem>
            {messageActionParityEnabled && (
              <DropdownMenuItem
                onSelect={onCopyLink}
                disabled={disableRelationActions || isUndecrypted}
              >
                <Link2 />
                Copy link
              </DropdownMenuItem>
            )}
            {messageActionParityEnabled && onForward && !isError && (
              <DropdownMenuItem onSelect={onForward} disabled={isUndecrypted}>
                <Forward />
                Forward
              </DropdownMenuItem>
            )}
            {messageActionParityEnabled && onViewSource && (
              <DropdownMenuItem onSelect={onViewSource}>
                <FileJson />
                View source
              </DropdownMenuItem>
            )}
            {messageActionParityEnabled && isEdited && onViewEditHistory && (
              <DropdownMenuItem onSelect={onViewEditHistory}>
                <History />
                Edit history
              </DropdownMenuItem>
            )}
            {canPin && !isError && (isPinned ? onUnpin : onPin) && (
              <DropdownMenuItem
                onSelect={isPinned ? onUnpin : onPin}
                // Review fix: `unpin_event` only needs the event ID — it
                // doesn't touch message content — so an already-pinned but
                // currently-undecrypted event (e.g. after a key gap or
                // restore) must still be unpinnable. Gating Unpin on
                // `isUndecrypted` the same way Pin/reply/react/edit are
                // would leave it stuck pinned forever with no other way to
                // remove it, since this is the only unpin affordance Spec
                // day-2/04 defines.
                disabled={disableRelationActions || (isUndecrypted && !isPinned)}
              >
                {isPinned ? <PinOff /> : <Pin />}
                {isPinned ? "Unpin" : "Pin"}
              </DropdownMenuItem>
            )}
            {bookmarksEnabled &&
              // Review fix: `disableRelationActions` already identifies a
              // pending/failed local echo, whose `event_id` is a
              // transaction id rather than a real Matrix event id — a
              // bookmark saved against that id would either fail server-side
              // or, worse, silently point at nothing once the real event id
              // is assigned. Gate on the same flag other relation-dependent
              // actions (reply/edit) already use, not just `isUndecrypted`.
              (isBookmarked && onUnbookmark ? (
                <DropdownMenuItem
                  onSelect={onUnbookmark}
                  disabled={disableRelationActions || isUndecrypted}
                >
                  <BookmarkX />
                  Remove bookmark
                </DropdownMenuItem>
              ) : (
                onBookmark && (
                  <DropdownMenuItem
                    onSelect={onBookmark}
                    disabled={disableRelationActions || isUndecrypted}
                  >
                    <Bookmark />
                    Bookmark
                  </DropdownMenuItem>
                )
              ))}
            {messageActionParityEnabled && isError && onResend && (
              <DropdownMenuItem onSelect={onResend}>
                <RotateCw />
                Resend
              </DropdownMenuItem>
            )}
            {messageActionParityEnabled && isError && onDiscard && (
              <DropdownMenuItem variant="destructive" onSelect={onDiscard}>
                <X />
                Discard
              </DropdownMenuItem>
            )}
            {messageActionParityEnabled && !isOwn && onReport && !isError && (
              <DropdownMenuItem variant="destructive" onSelect={onReport} disabled={isUndecrypted}>
                <Flag />
                Report
              </DropdownMenuItem>
            )}
            {canRedact && !isError && (
              <DropdownMenuItem
                variant="destructive"
                onSelect={onDelete}
                disabled={disableRelationActions}
              >
                <Trash2 />
                Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  },
);
