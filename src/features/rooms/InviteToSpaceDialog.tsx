import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { inviteMember } from "@/lib/matrix";

const MXID_PATTERN = /^@[^:]+:.+$/;

interface InviteToSpaceDialogProps {
  spaceId: string | null;
  spaceName: string | null;
  onOpenChange: (open: boolean) => void;
}

/** Context-menu-triggered counterpart to `InviteMemberDialog` — that
 * component owns its own trigger button, which doesn't fit a menu item, so
 * this is a controlled sibling driven by `SpaceRail`'s context menu instead.
 * Plain async state rather than `useMutation`, since `SpaceRail` (and thus
 * this dialog) renders outside a `QueryClientProvider` in several call
 * sites/tests. */
export function InviteToSpaceDialog({
  spaceId,
  spaceName,
  onOpenChange,
}: InviteToSpaceDialogProps) {
  const [userId, setUserId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Guards against stale state if `spaceId` changes while the dialog stays
  // open — `handleClose`'s reset only runs on an open->closed transition.
  useEffect(() => {
    setUserId("");
    setError(null);
    setPending(false);
  }, [spaceId]);

  function handleClose(open: boolean) {
    if (!open) {
      setUserId("");
      setError(null);
      setPending(false);
    }
    onOpenChange(open);
  }

  async function handleInvite() {
    if (!spaceId) return;
    if (!MXID_PATTERN.test(userId)) {
      setError("Enter a valid Matrix ID, e.g. @user:example.org");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await inviteMember(spaceId, userId);
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
          <DialogTitle>Invite to {spaceName ?? "space"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="invite-space-mxid">Matrix ID</Label>
          <Input
            id="invite-space-mxid"
            placeholder="@user:example.org"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)}>
            Cancel
          </Button>
          <Button onClick={handleInvite} disabled={pending}>
            Send invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
