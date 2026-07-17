import { AvatarBadge } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { PresenceStateDto } from "@/lib/matrix";
import { cn } from "@/lib/utils";

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

/** Formats a `last_active_ago_ms` duration as a short relative string, e.g.
 * `Active just now`, `Active 5m ago`, `Active 3h ago`, `Active 2d ago`. Spec
 * 40, item 6 — the field already exists on `PresenceUpdate` but was never
 * rendered anywhere. */
export function formatLastActiveAgo(lastActiveAgoMs: number): string {
  const minutes = Math.floor(lastActiveAgoMs / 60_000);
  if (minutes < 1) return "Active just now";
  if (minutes < 60) return `Active ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Active ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Active ${days}d ago`;
}

interface PresenceDotProps {
  presence: PresenceStateDto | null | undefined;
  className?: string;
  /** Presence status message (`m.presence`'s `status_msg`), shown in the
   * tooltip when present — Spec 40, item 6. */
  statusMsg?: string | null;
  /** Milliseconds since the user was last active, shown in the tooltip when
   * present — Spec 40, item 6. */
  lastActiveAgoMs?: number | null;
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
 * hidden sibling carries the actual label for screen readers. When a status
 * message or last-active time is available, the dot is wrapped in a tooltip
 * surfacing both (Spec 40, item 6) — previously-unused fields on the same
 * `PresenceUpdate` DTO Spec 05 already delivers.
 */
export function PresenceDot({ presence, className, statusMsg, lastActiveAgoMs }: PresenceDotProps) {
  if (!presence) return null;

  const dot = (
    <>
      <AvatarBadge
        aria-hidden="true"
        style={{ background: PRESENCE_COLORS[presence] }}
        className={cn(className)}
      />
      <span className="sr-only">{PRESENCE_LABELS[presence]}</span>
    </>
  );

  if (!statusMsg && lastActiveAgoMs == null) {
    return dot;
  }

  const tooltipLines = [
    PRESENCE_LABELS[presence],
    statusMsg ?? undefined,
    lastActiveAgoMs != null ? formatLastActiveAgo(lastActiveAgoMs) : undefined,
  ].filter((line): line is string => Boolean(line));

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* tabIndex={0}: same accessible-tooltip-trigger pattern as
              `BubbleMessageRow`'s read-receipt chips — the badge itself
              isn't a native interactive element. */}
          {/* oxlint-disable jsx-a11y/no-noninteractive-tabindex */}
          <span tabIndex={0} className="contents">
            {dot}
          </span>
          {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */}
        </TooltipTrigger>
        <TooltipContent>
          {tooltipLines.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
