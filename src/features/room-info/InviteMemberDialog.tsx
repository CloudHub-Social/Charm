import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useRoomAdminActions } from "./useRoomAdminActions";

/** A syntactically valid MXID: `@localpart:server` — mirrors Matrix's user id grammar closely enough to catch typos before round-tripping to the homeserver. */
const MXID_PATTERN = /^@[^:]+:.+$/;

interface InviteMemberDialogProps {
  roomId: string;
  disabled: boolean;
}

export function InviteMemberDialog({ roomId, disabled }: InviteMemberDialogProps) {
  const actions = useRoomAdminActions(roomId);
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleInvite() {
    if (!MXID_PATTERN.test(userId)) {
      setError("Enter a valid Matrix ID, e.g. @user:example.org");
      return;
    }
    setError(null);
    actions.invite.mutate(userId, {
      onSuccess: () => {
        setOpen(false);
        setUserId("");
      },
      onError: (err) => setError(err.message),
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setUserId("");
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" disabled={disabled}>
          Invite
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite member</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="invite-mxid">Matrix ID</Label>
          <Input
            id="invite-mxid"
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
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleInvite}>Send invite</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
