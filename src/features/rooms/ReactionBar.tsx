import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  const [detailErrorsByKey, setDetailErrorsByKey] = useState<Record<string, boolean>>({});
  const [modalKey, setModalKeyState] = useState<string | null>(null);
  // Keep the synchronous request lifecycle in refs and use a per-key
  // generation to prevent duplicate requests and discard responses invalidated
  // by tooltip close/refetch.
  const inFlightKeysRef = useRef(new Set<string>());
  const requestGenerationRef = useRef<Record<string, number>>({});
  // Mirrors `modalKey` for synchronous reads inside `clearDetails` — React
  // batches the "View all" button's `setModalKey` with the state update
  // from the Tooltip's own `onOpenChange(false)` (both fire from the same
  // click), so `clearDetails` reading the `modalKey` *state* would still see
  // the pre-click value and wrongly clear the cache the modal is about to
  // read from. The ref is updated in the same tick as the click, before
  // React's batched re-render.
  const modalKeyRef = useRef<string | null>(null);
  function setModalKey(key: string | null) {
    modalKeyRef.current = key;
    setModalKeyState(key);
  }
  // Records the reaction `count` the cache entry for a given key was last
  // fetched at, so the modal-open effect below can tell "still fresh" from
  // "a reaction arrived/left while the modal was open" without folding
  // count into the cache key itself (see `loadDetails`'s doc comment for
  // why that was the wrong axis to key on).
  const fetchedAtCountRef = useRef<Record<string, number>>({});

  // Cache keyed by the emoji `key` alone — see `clearDetails` for why count
  // must not be part of the key. `force` bypasses the "already cached"
  // check for the modal-open / count-changed refetch below, where a stale
  // cached entry needs replacing rather than being treated as fresh.
  function loadDetails(reaction: ReactionGroup, options?: { force?: boolean }) {
    if (!messageActionParityEnabled || !roomId || !eventId) return;
    const key = reaction.key;
    if (!options?.force && (detailsByKey[key] || inFlightKeysRef.current.has(key))) return;
    const generation = (requestGenerationRef.current[key] ?? 0) + 1;
    requestGenerationRef.current[key] = generation;
    inFlightKeysRef.current.add(key);
    setDetailErrorsByKey((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    getReactionDetails(roomId, eventId, key)
      .then((details) => {
        if (requestGenerationRef.current[key] !== generation) return;
        fetchedAtCountRef.current[key] = reaction.count;
        setDetailsByKey((prev) => ({ ...prev, [key]: details }));
      })
      .catch(() => {
        if (requestGenerationRef.current[key] !== generation) return;
        setDetailErrorsByKey((prev) => ({ ...prev, [key]: true }));
      })
      .finally(() => {
        if (requestGenerationRef.current[key] !== generation) return;
        inFlightKeysRef.current.delete(key);
      });
  }
  function clearDetails(reaction: ReactionGroup) {
    // Keep the entry around if its modal is open — WhoReactedDialog reads
    // from this same cache and closing the tooltip shouldn't blank it out.
    // Reads the ref (not the `modalKey` state) — see its declaration above.
    if (modalKeyRef.current === reaction.key) return;
    requestGenerationRef.current[reaction.key] =
      (requestGenerationRef.current[reaction.key] ?? 0) + 1;
    inFlightKeysRef.current.delete(reaction.key);
    delete fetchedAtCountRef.current[reaction.key];
    setDetailErrorsByKey((prev) => {
      if (!(reaction.key in prev)) return prev;
      const next = { ...prev };
      delete next[reaction.key];
      return next;
    });
    setDetailsByKey((prev) => {
      if (!(reaction.key in prev)) return prev;
      const next = { ...prev };
      delete next[reaction.key];
      return next;
    });
  }

  const modalReaction = reactions.find((reaction) => reaction.key === modalKey);

  // Live-refreshes the modal's reactor list while it's open: a reaction
  // arriving/leaving mid-view changes `count` without necessarily closing
  // the modal, and the cache (keyed by emoji alone, not count — see
  // `loadDetails`) wouldn't otherwise notice the underlying data went
  // stale. Force-refetches whenever the count drifts from what the cached
  // entry was actually fetched at.
  useEffect(() => {
    if (!modalReaction) return;
    if (fetchedAtCountRef.current[modalReaction.key] === modalReaction.count) return;
    loadDetails(modalReaction, { force: true });
    // loadDetails is stable across renders (recreated each render but with
    // the same closed-over deps as this effect); including it would just
    // re-run this effect every render without changing behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalReaction?.key, modalReaction?.count]);

  if (reactions.length === 0) {
    return null;
  }

  const chips = reactions.map((reaction) => {
    const chip = (
      <button
        key={reaction.key}
        type="button"
        onClick={() => onToggle(reaction.key)}
        onMouseEnter={() => loadDetails(reaction)}
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
    const detailError = detailErrorsByKey[reaction.key];
    return (
      <Tooltip key={reaction.key} onOpenChange={(open) => !open && clearDetails(reaction)}>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent>
          {detailError ? (
            "Could not load reactions."
          ) : !details ? (
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
                  View all {reaction.count}
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
        details={modalReaction ? (detailsByKey[modalReaction.key] ?? []) : []}
        onOpenChange={(open) => !open && setModalKey(null)}
      />
    </TooltipProvider>
  );
}
