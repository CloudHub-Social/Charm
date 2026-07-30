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
  const [tooltipKey, setTooltipKeyState] = useState<string | null>(null);
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
  const tooltipKeyRef = useRef<string | null>(null);
  function setModalKey(key: string | null) {
    modalKeyRef.current = key;
    setModalKeyState(key);
  }
  function setTooltipKey(key: string | null) {
    tooltipKeyRef.current = key;
    setTooltipKeyState(key);
  }
  // Cache keyed by the emoji `key` alone — see `clearDetails` for why count
  // must not be part of the key. `force` bypasses the "already cached"
  // check when a new timeline reaction snapshot arrives while a viewer is
  // open, where a stale cached entry needs replacing rather than being
  // treated as fresh.
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
  function clearDetails(key: string) {
    // Keep the entry around if its modal is open — WhoReactedDialog reads
    // from this same cache and closing the tooltip shouldn't blank it out.
    // Reads the ref (not the `modalKey` state) — see its declaration above.
    if (modalKeyRef.current === key) return;
    requestGenerationRef.current[key] = (requestGenerationRef.current[key] ?? 0) + 1;
    inFlightKeysRef.current.delete(key);
    setDetailErrorsByKey((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setDetailsByKey((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function closeModal() {
    const key = modalKeyRef.current;
    // Clear the ref first so clearDetails performs the invalidation it
    // intentionally deferred while the modal was using this cache entry.
    setModalKey(null);
    if (key) clearDetails(key);
  }

  const modalReaction = reactions.find((reaction) => reaction.key === modalKey);
  const tooltipReaction = reactions.find((reaction) => reaction.key === tooltipKey);

  // Live-refresh every visible reactor list whenever the timeline supplies
  // a new reaction snapshot. Count alone is not a freshness token: one
  // reactor can leave while another joins in the same update, preserving
  // both `count` and `reacted_by_me` while changing the actual membership.
  // State updates from the request retain the same `reactions` prop
  // reference, so this does not loop after the refreshed details land.
  useEffect(() => {
    const activeReactions = [modalReaction, tooltipReaction].filter(
      (reaction): reaction is ReactionGroup => reaction !== undefined,
    );
    const refreshedKeys = new Set<string>();
    for (const reaction of activeReactions) {
      if (refreshedKeys.has(reaction.key)) continue;
      refreshedKeys.add(reaction.key);
      if (inFlightKeysRef.current.has(reaction.key)) continue;
      loadDetails(reaction, { force: true });
    }
    // loadDetails is stable across renders (recreated each render but with
    // the same closed-over deps as this effect); including it would just
    // re-run this effect every render without changing behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reactions]);

  // A focused trigger can be removed by a live timeline update without
  // emitting blur/mouseleave. Close any viewer for that vanished key and
  // invalidate its cache so a later reaction using the same emoji cannot
  // inherit the previous reactor list.
  useEffect(() => {
    if (modalKey !== null && modalReaction === undefined) {
      closeModal();
    }
    if (tooltipKey !== null && tooltipReaction === undefined) {
      const vanishedKey = tooltipKey;
      setTooltipKey(null);
      clearDetails(vanishedKey);
    }
    // closeModal and clearDetails are intentionally local lifecycle helpers;
    // their relevant inputs are represented explicitly below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalKey, modalReaction, tooltipKey, tooltipReaction]);

  if (reactions.length === 0) {
    return null;
  }

  const chips = reactions.map((reaction) => {
    const chip = (
      <button
        key={reaction.key}
        type="button"
        onClick={() => onToggle(reaction.key)}
        // Radix opens the tooltip for either input path; load for both so
        // keyboard and assistive-technology users receive the same details.
        onMouseEnter={() => loadDetails(reaction)}
        onFocus={() => loadDetails(reaction)}
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
      <span
        key={reaction.key}
        className="flex items-center gap-1"
        onMouseLeave={() => clearDetails(reaction.key)}
        onBlur={(event) => {
          const nextTarget = event.relatedTarget;
          if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
            clearDetails(reaction.key);
          }
        }}
      >
        <Tooltip
          onOpenChange={(open) => {
            if (open) {
              setTooltipKey(reaction.key);
              return;
            }
            if (tooltipKeyRef.current === reaction.key) setTooltipKey(null);
          }}
        >
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
              </div>
            )}
          </TooltipContent>
        </Tooltip>
        <button
          type="button"
          aria-label={`View all ${reaction.count} reactions for ${reaction.key}`}
          disabled={disabled}
          className="h-6 rounded-full border border-border px-2 text-xs text-muted-foreground hover:bg-secondary disabled:pointer-events-none disabled:opacity-40"
          onClick={() => {
            loadDetails(reaction);
            setModalKey(reaction.key);
          }}
        >
          {reaction.count > TOOLTIP_NAME_LIMIT ? `View all ${reaction.count}` : "View reactors"}
        </button>
      </span>
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
        loading={
          modalReaction !== undefined &&
          detailsByKey[modalReaction.key] === undefined &&
          !detailErrorsByKey[modalReaction.key]
        }
        error={modalReaction !== undefined && detailErrorsByKey[modalReaction.key]}
        onRetry={() => modalReaction && loadDetails(modalReaction, { force: true })}
        onOpenChange={(open) => !open && closeModal()}
      />
    </TooltipProvider>
  );
}
