import { useEffect, useState } from "react";
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
  /** Called with the space's id right after a successful leave — distinct from
   * `onOpenChange(false)` (which also fires on plain Cancel) so the caller can
   * redirect out of a now-inaccessible space without reacting to a cancel. */
  onLeft?: (spaceId: string) => void;
}

/** Confirmation dialog for leaving a space from `SpaceRail`'s context menu — leaving is
 * destructive enough (loses access to every private child room too) to warrant a confirm
 * step, unlike the reversible Pin/Remove-from-space actions next to it in the same menu. */
export function LeaveSpaceDialog({
  spaceId,
  spaceName,
  onOpenChange,
  onLeft,
}: LeaveSpaceDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Guards against stale state if `spaceId` changes while the dialog stays
  // open (e.g. the context menu re-targets it without the caller closing it
  // first) — `handleClose`'s reset only runs on an open->closed transition.
  useEffect(() => {
    setError(null);
    setPending(false);
  }, [spaceId]);

  function handleClose(open: boolean) {
    // Ignore dismiss attempts (Escape, outside click, the close button, or
    // Cancel) while a leave request is in flight — closing here wouldn't
    // cancel `handleLeave`'s in-progress `leaveRoom` call, so the user could
    // back out of the dialog while still about to lose access to the space.
    if (!open && pending) return;
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
      onLeft?.(spaceId);
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
          <Button variant="outline" onClick={() => handleClose(false)} disabled={pending}>
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
