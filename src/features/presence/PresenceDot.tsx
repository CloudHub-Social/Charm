import { useEffect, useRef, useState } from "react";
import { AvatarBadge } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { PresenceStateDto } from "@/lib/matrix";
import { cn } from "@/lib/utils";
import { useFlag } from "@/featureFlags";

const PRESENCE_COLORS: Record<PresenceStateDto, string> = {
  online: "var(--color-success)",
  unavailable: "var(--color-warning)",
  offline: "var(--color-text-muted)",
};

const PRESENCE_LABELS: Record<PresenceStateDto, string> = {
  online: "Online",
  unavailable: "Away",
  offline: "Offline",
};

/**
 * Formats `last_active_ago_ms` (Spec 40 item 6 — the `PresenceUpdate` DTO
 * already carries this, it was just never rendered) as a short relative
 * string: "Active just now" / "Active 5m ago" / "Active 3h ago" / "Active
 * 2d ago". Deliberately coarse (largest unit only, floored) — this is a
 * presence hint, not a precise timestamp.
 */
export function formatLastActiveAgo(lastActiveAgoMs: number): string {
  if (lastActiveAgoMs < 60_000) return "Active just now";
  const minutes = Math.floor(lastActiveAgoMs / 60_000);
  if (minutes < 60) return `Active ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Active ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Active ${days}d ago`;
}

/**
 * Anchors a `last_active_ago_ms` snapshot (relative to whenever the
 * `PresenceUpdate` that carried it arrived) to an absolute point in time,
 * so the label stays accurate at whenever it's actually *rendered* — not
 * frozen at however long ago the update happened to land.
 *
 * Review fix: without this, `formatLastActiveAgo` was called directly on
 * the raw prop every render, which is only ever the correct elapsed time
 * at the exact instant the update arrived. A DM header/list row that stays
 * mounted without a further presence event (no re-render to recompute
 * anything) could keep showing "Active 5m ago" for hours. Re-anchoring
 * only when `lastActiveAgoMs` itself changes (a genuinely new update, not
 * just an unrelated parent re-render) means every render after that reads
 * `Date.now()` fresh against a fixed point in time instead.
 */
// Review fix: re-anchoring alone only recomputes the label when something
// *else* triggers a render (a new presence update, a parent re-render,
// etc). A DM header/list row that stays mounted with no further presence
// event kept showing a frozen "Active 5m ago" label forever, since nothing
// was scheduling a re-render purely to let time pass. A 60s interval tick
// forces a re-render so the label keeps aging on its own; the interval
// itself is cheap (one `setState` a minute) and only runs while a
// timestamp is actually being shown.
const LAST_ACTIVE_TICK_MS = 60_000;

// Review fix (P3): re-anchoring keyed only on `lastActiveAgoMs`'s numeric
// value missed a fresh update that happens to carry the *same* value as the
// previous one — e.g. two consecutive "just now" (`0`) updates as a peer
// stays active. That looked like no update at all, so the anchor (and so
// the displayed label) kept aging from the *first* one's arrival time
// instead of resetting to the second's, and could show a stale "Active 30m
// ago" immediately after a fresh just-now update landed. `updateToken` is an
// opaque per-update identity (callers pass the `PresenceUpdate` object
// itself, which is a fresh reference on every incoming update even when its
// fields are numerically identical) — re-anchoring on *either* the value or
// this token changing catches a same-value update that a value-only compare
// would treat as a no-op.
function useAnchoredLastActiveAgoMs(
  lastActiveAgoMs: number | null | undefined,
  updateToken: unknown,
): number | null {
  const anchorRef = useRef<{ source: number; token: unknown; at: number } | null>(null);
  const [, forceRerender] = useState(0);

  if (lastActiveAgoMs == null) {
    anchorRef.current = null;
  } else if (
    anchorRef.current === null ||
    anchorRef.current.source !== lastActiveAgoMs ||
    anchorRef.current.token !== updateToken
  ) {
    anchorRef.current = {
      source: lastActiveAgoMs,
      token: updateToken,
      at: Date.now() - lastActiveAgoMs,
    };
  }

  useEffect(() => {
    if (lastActiveAgoMs == null) return;
    const id = setInterval(() => forceRerender((n) => n + 1), LAST_ACTIVE_TICK_MS);
    return () => clearInterval(id);
  }, [lastActiveAgoMs]);

  if (anchorRef.current === null) return null;
  return Date.now() - anchorRef.current.at;
}

interface PresenceDotProps {
  presence: PresenceStateDto | null | undefined;
  /** Custom presence status message (e.g. "Making cupcakes"), from `PresenceUpdate.status_msg`. */
  statusMsg?: string | null;
  /** Milliseconds since this user was last active, from `PresenceUpdate.last_active_ago_ms`. */
  lastActiveAgoMs?: number | null;
  /**
   * An opaque per-update identity — pass the `PresenceUpdate` object itself
   * (e.g. `usePresence`'s return value). Lets the last-active anchor tell a
   * genuinely fresh update apart from an unrelated re-render even when the
   * new update happens to carry the exact same `lastActiveAgoMs` value as
   * the previous one (e.g. two consecutive "just now" pings) — see
   * `useAnchoredLastActiveAgoMs`'s own comment. Optional: omitting it just
   * means same-value repeats won't re-anchor, matching the prior behavior.
   */
  updateToken?: unknown;
  className?: string;
  /**
   * Set when the caller already renders this inside its own interactive
   * element (e.g. `RoomListItem`'s whole row is a `<button>`). The detail
   * tooltip's trigger is then rendered non-`tabIndex`-focusable, since a
   * focusable element nested inside another interactive one is an axe
   * `nested-interactive` violation this repo's Storybook a11y gate
   * enforces — mouse hover still opens it regardless (`onPointerMove` isn't
   * gated on `tabIndex`); keyboard/screen-reader users reach the same
   * presence detail via the outer row control instead. Defaults to `false`
   * for standalone placements like `ChatShell`'s DM header, which isn't
   * itself interactive.
   */
  insideInteractiveParent?: boolean;
}

/**
 * A colored `AvatarBadge` dot for a user's presence — shared by `ChatShell`'s
 * DM header and `RoomListItem`'s DM avatar (both key it off `usePresence`).
 * Renders nothing when presence is unknown (not yet fetched), rather than a
 * default/offline dot that would misleadingly imply a real state.
 *
 * The dot itself is `aria-hidden` (a colored circle has no ARIA role that
 * accepts an accessible name without also changing its semantics — see
 * `RoomListItem.tsx`'s marked-unread dot for the same pattern); a visually-
 * hidden sibling carries the actual label for screen readers.
 *
 * When `statusMsg`/`lastActiveAgoMs` are provided (Spec 40 item 6), a
 * tooltip surfaces them alongside the presence label — previously carried by
 * the `PresenceUpdate` DTO but never shown anywhere.
 */
export function PresenceDot({
  presence,
  statusMsg,
  lastActiveAgoMs,
  updateToken,
  className,
  insideInteractiveParent = false,
}: PresenceDotProps) {
  // Review fix: the status-message/last-active detail tooltip is Spec 40's
  // own display addition and must be killed by the same default-off
  // `presence_privacy_controls` flag that gates the rest of that spec — the
  // call sites (`ChatShell`, `RoomListItem`) pass these fields unconditionally,
  // so gating has to happen here, not at each caller.
  const detailEnabled = useFlag("presence_privacy_controls");
  // Called unconditionally, before the early `return null` below, per the
  // rules of hooks — the anchor itself is cheap to maintain even when
  // there's no `presence` to render yet.
  const anchoredLastActiveAgoMs = useAnchoredLastActiveAgoMs(lastActiveAgoMs, updateToken);
  if (!presence) return null;

  const label = PRESENCE_LABELS[presence];
  const tooltipLines = [
    detailEnabled && statusMsg ? `${label} — ${statusMsg}` : label,
    detailEnabled && anchoredLastActiveAgoMs != null
      ? formatLastActiveAgo(anchoredLastActiveAgoMs)
      : null,
  ].filter((line): line is string => line != null);

  const dot = (
    <AvatarBadge
      aria-hidden="true"
      style={{ background: PRESENCE_COLORS[presence] }}
      className={cn(className)}
    />
  );

  // No extra detail to show — skip the tooltip machinery entirely and keep
  // the plain sr-only label Spec 05 shipped.
  if (tooltipLines.length <= 1 && tooltipLines[0] === label) {
    return (
      <>
        {dot}
        <span className="sr-only">{label}</span>
      </>
    );
  }

  return (
    <TooltipProvider>
      <Tooltip>
        {/* tabIndex={0}: keyboard/screen-reader users get the same detail a
            mouse hover gives — the dot itself has no interactive role.
            Omitted when `insideInteractiveParent` (see that prop's own
            comment) to avoid nesting a focusable element inside the
            caller's own interactive row/button. */}
        {/* oxlint-disable jsx-a11y/no-noninteractive-tabindex */}
        <TooltipTrigger asChild>
          <span tabIndex={insideInteractiveParent ? undefined : 0} className="inline-flex">
            {dot}
          </span>
        </TooltipTrigger>
        {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */}
        <TooltipContent>
          {tooltipLines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </TooltipContent>
      </Tooltip>
      <span className="sr-only">{tooltipLines.join(". ")}</span>
    </TooltipProvider>
  );
}
