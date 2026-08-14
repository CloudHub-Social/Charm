import { useState } from "react";

interface RoomUpgradeBannerProps {
  replacementRoomId: string | null;
  onFollowUpgrade?: (roomIdentifier: string) => Promise<void>;
}

export function RoomUpgradeStatePending() {
  return (
    <output className="mx-3 mb-3 rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
      Checking whether this room is still active… Sending is unavailable until room state loads.
    </output>
  );
}

export function RoomUpgradeBanner({ replacementRoomId, onFollowUpgrade }: RoomUpgradeBannerProps) {
  const [following, setFollowing] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);

  async function followUpgrade() {
    if (!replacementRoomId || !onFollowUpgrade || following) return;
    setFollowing(true);
    setFollowError(null);
    try {
      await onFollowUpgrade(replacementRoomId);
    } catch {
      setFollowError("Couldn't open the upgraded room. Check your access and try again.");
    } finally {
      setFollowing(false);
    }
  }

  return (
    <output className="mx-3 mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <div>
        <p className="text-sm font-semibold text-foreground">This room has been upgraded</p>
        <p className="text-xs text-muted-foreground">
          This room is read-only. Continue the conversation in the replacement room.
        </p>
        {followError && <p className="mt-1 text-xs text-destructive">{followError}</p>}
      </div>
      {replacementRoomId && (
        <button
          type="button"
          onClick={followUpgrade}
          disabled={!onFollowUpgrade || following}
          className="rounded-md bg-primary-solid px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
        >
          {following ? "Opening upgraded room…" : "Go to upgraded room"}
        </button>
      )}
    </output>
  );
}
