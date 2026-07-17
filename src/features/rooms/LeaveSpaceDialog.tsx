import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { leaveRoom } from "@/lib/matrix";

interface LeaveSpaceDialogProps {
  spaceId: string | null;
  spaceName: string | null;
  onOpenChange: (open: boolean) => void;
}

/** Confirmation dialog for leaving a space from `SpaceRail`'s context menu — leaving is
 * destructive enough (loses access to every private child room too) to warrant a confirm
 * step, unlike the reversible Pin/Remove-from-space actions next to it in the same menu. */
export function LeaveSpaceDialog({ spaceId, spaceName, onOpenChange }: LeaveSpaceDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function handleClose(open: boolean) {
    if (!open) {
      setError(null);
      setPending(false);
    }
    onOpenChange(open);
  }

  async function handleLeave() {
    if (!spaceId) return;
    setError(null);
    setPending(true);
    try {
      await leaveRoom(spaceId);
      handleClose(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={spaceId !== null} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Leave {spaceName ?? "space"}?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          You'll lose access to any of its private child rooms and need a new invite to rejoin.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleLeave} disabled={pending}>
            Leave
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
