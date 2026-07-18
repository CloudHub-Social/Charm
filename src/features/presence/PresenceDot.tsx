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

interface PresenceDotProps {
  presence: PresenceStateDto | null | undefined;
  /** Custom presence status message (e.g. "Making cupcakes"), from `PresenceUpdate.status_msg`. */
  statusMsg?: string | null;
  /** Milliseconds since this user was last active, from `PresenceUpdate.last_active_ago_ms`. */
  lastActiveAgoMs?: number | null;
  className?: string;
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
export function PresenceDot({ presence, statusMsg, lastActiveAgoMs, className }: PresenceDotProps) {
  // Review fix: the status-message/last-active detail tooltip is Spec 40's
  // own display addition and must be killed by the same default-off
  // `presence_privacy_controls` flag that gates the rest of that spec — the
  // call sites (`ChatShell`, `RoomListItem`) pass these fields unconditionally,
  // so gating has to happen here, not at each caller.
  const detailEnabled = useFlag("presence_privacy_controls");
  if (!presence) return null;

  const label = PRESENCE_LABELS[presence];
  const tooltipLines = [
    detailEnabled && statusMsg ? `${label} — ${statusMsg}` : label,
    detailEnabled && lastActiveAgoMs != null ? formatLastActiveAgo(lastActiveAgoMs) : null,
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
            mouse hover gives — the dot itself has no interactive role. */}
        {/* oxlint-disable jsx-a11y/no-noninteractive-tabindex */}
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex">
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
