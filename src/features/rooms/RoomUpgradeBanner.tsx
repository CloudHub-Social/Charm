interface RoomUpgradeBannerProps {
  replacementRoomId: string | null;
  onNavigateToRoom?: (roomIdentifier: string) => void;
}

export function RoomUpgradeBanner({
  replacementRoomId,
  onNavigateToRoom,
}: RoomUpgradeBannerProps) {
  return (
    <output className="mx-3 mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <div>
        <p className="text-sm font-semibold text-foreground">This room has been upgraded</p>
        <p className="text-xs text-muted-foreground">
          This room is read-only. Continue the conversation in the replacement room.
        </p>
      </div>
      {replacementRoomId && (
        <button
          type="button"
          onClick={() => onNavigateToRoom?.(replacementRoomId)}
          className="rounded-md bg-primary-solid px-3 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
        >
          Go to upgraded room
        </button>
      )}
    </output>
  );
}
