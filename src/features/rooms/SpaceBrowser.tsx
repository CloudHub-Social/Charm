import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  joinRoom,
  knockRoom,
  listSpaceChildren,
  type RoomSummary,
  type SpaceChild,
} from "@/lib/matrix";

interface SpaceBrowserProps {
  space: RoomSummary | null;
  onOpenChange: (open: boolean) => void;
}

/** Dialog listing a space's child rooms with Join / Request-to-join actions — Spec 06. */
export function SpaceBrowser({ space, onOpenChange }: SpaceBrowserProps) {
  const [children, setChildren] = useState<SpaceChild[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingRoomId, setPendingRoomId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!space) return undefined;
    // Guards against a stale fetch for a previous space resolving after the
    // user has since switched — without this, a failed fetch for space A
    // could set an error that displays alongside space B's successful results.
    let stale = false;
    setLoading(true);
    setError(null);
    listSpaceChildren(space.room_id)
      .then((result) => {
        if (!stale) setChildren(result);
      })
      .catch((err) => {
        if (!stale) setError(String(err));
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [space]);

  async function handleJoin(child: SpaceChild) {
    setPendingRoomId(child.room_id);
    setError(null);
    try {
      if (child.join_rule === "knock") {
        await knockRoom(child.room_id);
      } else {
        await joinRoom(child.room_id);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setPendingRoomId(null);
    }
  }

  return (
    <Dialog open={space !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{space?.name ?? space?.room_id}</DialogTitle>
          <DialogDescription>Browse and join rooms in this space.</DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading rooms…</p>
        ) : children.length === 0 ? (
          <p className="text-sm text-muted-foreground">No rooms in this space.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {children.map((child) => (
              <li
                key={child.room_id}
                className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {child.name ?? child.room_id}
                  </p>
                  {child.topic && (
                    <p className="truncate text-xs text-muted-foreground">{child.topic}</p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pendingRoomId === child.room_id}
                  onClick={() => handleJoin(child)}
                >
                  {child.join_rule === "knock" ? "Request to join" : "Join"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
