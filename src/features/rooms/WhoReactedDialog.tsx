import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ReactionDetail } from "@bindings/ReactionDetail";

interface WhoReactedDialogProps {
  open: boolean;
  reactionKey: string | null;
  details: ReactionDetail[];
  onOpenChange: (open: boolean) => void;
}

/** Full "who reacted" list for a single reaction, beyond what comfortably fits in the hover tooltip. */
export function WhoReactedDialog({
  open,
  reactionKey,
  details,
  onOpenChange,
}: WhoReactedDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Reacted with {reactionKey}</DialogTitle>
          <DialogDescription>
            {details.length} reaction{details.length === 1 ? "" : "s"}
          </DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-80 flex-col gap-1 overflow-auto text-sm">
          {details.map((detail) => (
            <li key={`${detail.sender}-${detail.origin_server_ts}`} className="truncate">
              {detail.sender}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
