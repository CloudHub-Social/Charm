import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Copy, Link2, MoreHorizontal, Pencil, Reply, SmilePlus, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useFlag } from "@/featureFlags";
import { EmojiPicker } from "./EmojiPicker";

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
 * the room's redact power level, read by the caller). Opens via the trigger
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
      className,
      disableRelationActions = false,
      isUndecrypted = false,
    },
    ref,
  ) {
    const messageActionParityEnabled = useFlag("message_action_parity");
    const [menuOpen, setMenuOpen] = useState(false);
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        <EmojiPicker onSelect={onReact}>
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
            {canRedact && (
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
