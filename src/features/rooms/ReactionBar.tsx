import { Plus } from "lucide-react";
import { useState } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getReactionDetails, type ReactionGroup } from "@/lib/matrix";
import type { ReactionDetail } from "@bindings/ReactionDetail";
import { useFlag } from "@/featureFlags";
import { EmojiPicker } from "./EmojiPicker";
import { WhoReactedDialog } from "./WhoReactedDialog";

interface ReactionBarProps {
  reactions: ReactionGroup[];
  onToggle: (key: string) => void;
  /**
   * Set while the message is still a local echo — its event id is a
   * temporary transaction id, so an `m.reaction` targeting it would fail
   * server-side. Disables both the toggle chips and the "add reaction" picker.
   */
  disabled?: boolean;
  /** Needed to fetch "who reacted" detail — omitted, the hover tooltip/modal is skipped. */
  roomId?: string;
  eventId?: string;
}

/** How many names the hover tooltip shows before pointing at the full modal instead. */
const TOOLTIP_NAME_LIMIT = 8;

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
export function ReactionBar({
  reactions,
  onToggle,
  disabled = false,
  roomId,
  eventId,
}: ReactionBarProps) {
  const messageActionParityEnabled = useFlag("message_action_parity");
  const [detailsByKey, setDetailsByKey] = useState<Record<string, ReactionDetail[]>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [modalKey, setModalKey] = useState<string | null>(null);

  if (reactions.length === 0) {
    return null;
  }

  function loadDetails(key: string) {
    if (!roomId || !eventId || detailsByKey[key] || loadingKey === key) return;
    setLoadingKey(key);
    getReactionDetails(roomId, eventId, key)
      .then((details) => {
        setDetailsByKey((prev) => ({ ...prev, [key]: details }));
      })
      .catch(() => {})
      .finally(() => setLoadingKey((prev) => (prev === key ? null : prev)));
  }

  const chips = reactions.map((reaction) => {
    const chip = (
      <button
        key={reaction.key}
        type="button"
        onClick={() => onToggle(reaction.key)}
        onMouseEnter={() => loadDetails(reaction.key)}
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
    );

    if (!messageActionParityEnabled || !roomId || !eventId) return chip;

    const details = detailsByKey[reaction.key];
    return (
      <Tooltip key={reaction.key}>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent>
          {!details ? (
            "Loading…"
          ) : details.length === 0 ? (
            "No reactions"
          ) : (
            <div className="flex flex-col gap-0.5">
              {details.slice(0, TOOLTIP_NAME_LIMIT).map((detail) => (
                <span key={`${detail.sender}-${detail.origin_server_ts}`}>{detail.sender}</span>
              ))}
              {details.length > TOOLTIP_NAME_LIMIT && (
                <button
                  type="button"
                  className="text-left underline"
                  onClick={(event) => {
                    event.stopPropagation();
                    setModalKey(reaction.key);
                  }}
                >
                  View all {details.length}
                </button>
              )}
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    );
  });

  return (
    <TooltipProvider>
      <div className="mt-0.5 flex flex-wrap items-center gap-1">
        {chips}
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
      <WhoReactedDialog
        open={modalKey !== null}
        reactionKey={modalKey}
        details={modalKey ? (detailsByKey[modalKey] ?? []) : []}
        onOpenChange={(open) => !open && setModalKey(null)}
      />
    </TooltipProvider>
  );
}
