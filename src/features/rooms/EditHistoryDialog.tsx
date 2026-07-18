import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { EditHistoryEntry } from "@bindings/EditHistoryEntry";
import { getEditHistory } from "@/lib/matrix";

interface EditHistoryDialogProps {
  open: boolean;
  roomId: string | null;
  eventId: string | null;
  onOpenChange: (open: boolean) => void;
}

function formatTimestamp(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestampMs));
}

/** Read-only edit history viewer: the original message followed by each
 * `m.replace` edit, oldest first, matching the order `get_edit_history`
 * already returns. */
export function EditHistoryDialog({ open, roomId, eventId, onOpenChange }: EditHistoryDialogProps) {
  const [entries, setEntries] = useState<EditHistoryEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !roomId || !eventId) {
      setEntries(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getEditHistory(roomId, eventId)
      .then((result) => {
        if (!cancelled) setEntries(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, roomId, eventId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit history</DialogTitle>
          <DialogDescription>
            The original message and each edit made to it, oldest first.
          </DialogDescription>
        </DialogHeader>
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && (
          <p role="alert" className="text-sm text-destructive-foreground">
            Could not load the edit history: {error}
          </p>
        )}
        {entries && (
          <ul className="flex max-h-96 flex-col gap-3 overflow-auto">
            {entries.map((entry, index) => (
              <li key={entry.event_id} className="rounded-md border border-border p-2 text-sm">
                <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{index === 0 ? "Original" : `Edit ${index}`}</span>
                  <span>{formatTimestamp(entry.origin_server_ts)}</span>
                </div>
                <div className="text-xs font-semibold">{entry.sender}</div>
                <p className="whitespace-pre-wrap">{entry.body}</p>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
