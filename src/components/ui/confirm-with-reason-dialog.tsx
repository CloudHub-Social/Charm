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
import { Label } from "@/components/ui/label";

interface ConfirmWithReasonDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  reasonLabel?: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string | null) => Promise<boolean>;
}

/** Shared destructive-action confirmation with an optional free-text reason. */
export function ConfirmWithReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  reasonLabel = "Reason (optional)",
  onOpenChange,
  onConfirm,
}: ConfirmWithReasonDialogProps) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) {
      setReason("");
      setSubmitting(false);
      setFailed(false);
    }
  }, [open]);

  async function confirm() {
    setSubmitting(true);
    setFailed(false);
    const trimmedReason = reason.trim();
    const succeeded = await onConfirm(trimmedReason === "" ? null : trimmedReason);
    setSubmitting(false);
    if (succeeded) onOpenChange(false);
    else setFailed(true);
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !submitting && onOpenChange(nextOpen)}>
      <DialogContent showCloseButton={!submitting}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="confirmation-reason">{reasonLabel}</Label>
          <textarea
            id="confirmation-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={submitting}
            rows={3}
            className="min-h-20 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
          />
          {failed && (
            <p role="alert" className="text-sm text-destructive-foreground">
              The action could not be completed. Please try again.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={submitting}>
            {submitting ? "Deleting…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
