import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { avatarColor, initials } from "./roomDisplay";

interface ReadByDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ordered list of user ids who have read to this point — same order the
   * caller already has (Spec 05's `useReadReceipts`), just not truncated. */
  readerIds: string[];
  senderNameByUserId: Map<string, string>;
}

/**
 * Full "seen by" list (Spec 40, item 5) — the receipt chip stack under a
 * message (`BubbleMessageRow`) is a fixed-size preview (`MAX_RECEIPT_AVATARS`);
 * this dialog shows everyone, not just a count, opened by clicking that
 * chip stack. Overlaps Spec 37's own read-by-list item; this is that same
 * feature.
 */
export function ReadByDialog({
  open,
  onOpenChange,
  readerIds,
  senderNameByUserId,
}: ReadByDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Read by</DialogTitle>
        </DialogHeader>
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {readerIds.map((userId) => {
            const name = senderNameByUserId.get(userId) ?? userId;
            return (
              <li key={userId} className="flex items-center gap-2 rounded-md px-2 py-1.5">
                <span
                  style={{ background: avatarColor(userId) }}
                  className="flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                >
                  {initials(userId, senderNameByUserId.get(userId) ?? null)}
                </span>
                <span className="truncate text-sm text-foreground">{name}</span>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
