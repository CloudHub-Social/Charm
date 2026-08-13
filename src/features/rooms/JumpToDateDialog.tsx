import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getEventAtTimestamp } from "@/lib/matrix";

interface JumpToDateDialogProps {
  open: boolean;
  roomId: string;
  onOpenChange: (open: boolean) => void;
  onResolved: (target: { eventId: string; timestampMs: number }) => void;
}

function localDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function JumpToDateDialog({
  open,
  roomId,
  onOpenChange,
  onResolved,
}: JumpToDateDialogProps) {
  const [date, setDate] = useState(() => localDateValue(new Date()));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const currentRoomId = useRef(roomId);
  currentRoomId.current = roomId;

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) requestId.current += 1;
    onOpenChange(nextOpen);
  }

  useEffect(() => {
    requestId.current += 1;
    setPending(false);
    setError(null);
    if (open) setDate(localDateValue(new Date()));
  }, [open, roomId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const timestamp = new Date(`${date}T00:00:00`).getTime();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      setError("Choose a valid date.");
      return;
    }
    const id = ++requestId.current;
    setPending(true);
    setError(null);
    try {
      const eventId = await getEventAtTimestamp(roomId, timestamp, "forward");
      if (requestId.current !== id || currentRoomId.current !== roomId) return;
      onResolved({ eventId, timestampMs: timestamp });
      handleOpenChange(false);
    } catch {
      if (requestId.current === id) {
        setError("No message was found on or after that date.");
      }
    } finally {
      if (requestId.current === id) setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Jump to date</DialogTitle>
          <DialogDescription>
            Charm will open the first available message on or after the selected date.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="jump-to-date">Date</Label>
            <Input
              id="jump-to-date"
              type="date"
              value={date}
              max={localDateValue(new Date())}
              onChange={(event) => setDate(event.currentTarget.value)}
              required
              disabled={pending}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !date}>
              {pending ? "Finding…" : "Jump"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
