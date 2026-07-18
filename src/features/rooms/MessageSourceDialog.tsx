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
import { getEventSource } from "@/lib/matrix";

interface MessageSourceDialogProps {
  open: boolean;
  roomId: string | null;
  eventId: string | null;
  onOpenChange: (open: boolean) => void;
}

/** Read-only raw event JSON viewer, for a "view source" debug affordance. */
export function MessageSourceDialog({
  open,
  roomId,
  eventId,
  onOpenChange,
}: MessageSourceDialogProps) {
  const [source, setSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open || !roomId || !eventId) {
      setSource(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCopied(false);
    getEventSource(roomId, eventId)
      .then((result) => {
        if (!cancelled) setSource(result);
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

  function handleCopy() {
    if (!source) return;
    navigator.clipboard
      ?.writeText(source)
      .then(() => setCopied(true))
      .catch(() => {});
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>View source</DialogTitle>
          <DialogDescription>
            The raw Matrix event JSON, as stored by the homeserver.
          </DialogDescription>
        </DialogHeader>
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && (
          <p role="alert" className="text-sm text-destructive-foreground">
            Could not load the event source: {error}
          </p>
        )}
        {source && (
          <pre className="max-h-96 overflow-auto rounded-md bg-secondary p-3 text-xs">
            <code>{source}</code>
          </pre>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={handleCopy} disabled={!source}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
