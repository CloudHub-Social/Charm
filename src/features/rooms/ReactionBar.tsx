import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReactionGroup } from "@/lib/matrix";
import { EmojiPicker } from "./EmojiPicker";

interface ReactionBarProps {
  reactions: ReactionGroup[];
  onToggle: (key: string) => void;
  /**
   * Set while the message is still a local echo — its event id is a
   * temporary transaction id, so an `m.reaction` targeting it would fail
   * server-side. Disables both the toggle chips and the "add reaction" picker.
   */
  disabled?: boolean;
}

/**
 * Renders a message's `ReactionGroup[]` as toggle chips, plus a trailing
 * `+` chip that opens a minimal emoji picker to add a new reaction. Own
 * reactions get an accent highlight; clicking any chip toggles it.
 *
 * Renders nothing when there are no reactions yet — starting a reaction is
 * already covered by the hover-revealed React button in `MessageActions`,
 * so an always-visible empty-state "+" here would just duplicate it and
 * reserve dead space under every message.
 */
export function ReactionBar({ reactions, onToggle, disabled = false }: ReactionBarProps) {
  if (reactions.length === 0) {
    return null;
  }

  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-1">
      {reactions.map((reaction) => (
        <button
          key={reaction.key}
          type="button"
          onClick={() => onToggle(reaction.key)}
          disabled={disabled}
          aria-pressed={reaction.reacted_by_me}
          className={cn(
            "flex h-6 min-w-11 items-center justify-center gap-1 rounded-full border px-2 text-xs disabled:pointer-events-none disabled:opacity-40",
            reaction.reacted_by_me
              ? "border-primary bg-primary/10 text-primary"
              : "border-border bg-secondary text-secondary-foreground",
          )}
        >
          <span>{reaction.key}</span>
          <span className="font-mono">{reaction.count}</span>
        </button>
      ))}
      <EmojiPicker onSelect={onToggle}>
        <button
          type="button"
          aria-label="Add reaction"
          disabled={disabled}
          className="flex size-6 items-center justify-center rounded-full border border-border text-muted-foreground hover:bg-secondary disabled:pointer-events-none disabled:opacity-40"
        >
          <Plus size={12} />
        </button>
      </EmojiPicker>
    </div>
  );
}
