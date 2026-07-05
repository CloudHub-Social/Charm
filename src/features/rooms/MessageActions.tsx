import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Copy, MoreHorizontal, Pencil, Reply, SmilePlus, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
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
  className?: string;
  /**
   * Set while the message is still a local echo (`send_state.state ===
   * "pending"`) — its event id is a temporary transaction id, not a real
   * server event id, so relation-based actions (reply/react/edit/delete)
   * would fail if attempted against it. Copy stays available since it only
   * needs the body text.
   */
  disableRelationActions?: boolean;
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
      className,
      disableRelationActions = false,
    },
    ref,
  ) {
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
        onTouchStart={startLongPress}
        onTouchEnd={cancelLongPress}
        onTouchCancel={cancelLongPress}
        onTouchMove={cancelLongPress}
      >
        <EmojiPicker onSelect={onReact}>
          <button
            type="button"
            aria-label="React"
            disabled={disableRelationActions}
            className="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary disabled:pointer-events-none disabled:opacity-40"
          >
            <SmilePlus size={16} />
          </button>
        </EmojiPicker>

        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
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
            <DropdownMenuItem onSelect={onReply} disabled={disableRelationActions}>
              <Reply />
              Reply
            </DropdownMenuItem>
            {isOwn && (
              <DropdownMenuItem onSelect={onEdit} disabled={disableRelationActions}>
                <Pencil />
                Edit
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={onCopy}>
              <Copy />
              Copy
            </DropdownMenuItem>
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
