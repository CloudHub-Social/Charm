import { AvatarBadge } from "@/components/ui/avatar";
import type { PresenceStateDto } from "@/lib/matrix";
import { cn } from "@/lib/utils";

const PRESENCE_COLORS: Record<PresenceStateDto, string> = {
  online: "var(--color-success)",
  unavailable: "var(--color-warning)",
  offline: "var(--gray-500)",
};

const PRESENCE_LABELS: Record<PresenceStateDto, string> = {
  online: "Online",
  unavailable: "Away",
  offline: "Offline",
};

interface PresenceDotProps {
  presence: PresenceStateDto | null | undefined;
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
 */
export function PresenceDot({ presence, className }: PresenceDotProps) {
  if (!presence) return null;
  return (
    <>
      <AvatarBadge
        aria-hidden="true"
        style={{ background: PRESENCE_COLORS[presence] }}
        className={cn(className)}
      />
      <span className="sr-only">{PRESENCE_LABELS[presence]}</span>
    </>
  );
}
