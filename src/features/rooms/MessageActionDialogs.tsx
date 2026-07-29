import { ConfirmWithReasonDialog } from "@/components/ui/confirm-with-reason-dialog";
import { EditHistoryDialog } from "./EditHistoryDialog";
import { ForwardMessageDialog } from "./ForwardMessageDialog";
import { MessageSourceDialog } from "./MessageSourceDialog";
import type { MessageActionDialogTarget } from "./useMessageActionController";

interface MessageActionDialogsProps {
  target: MessageActionDialogTarget | null;
  onClose: () => void;
  onConfirm: (target: MessageActionDialogTarget, reason: string | null) => Promise<boolean>;
}

export function MessageActionDialogs({ target, onClose, onConfirm }: MessageActionDialogsProps) {
  if (!target) return null;

  const onOpenChange = (open: boolean) => {
    if (!open) onClose();
  };

  switch (target.kind) {
    case "delete":
      return (
        <ConfirmWithReasonDialog
          open
          title="Delete message?"
          description="This removes the message for everyone in the room and cannot be undone."
          confirmLabel="Delete message"
          submittingLabel="Deleting…"
          reasonDescription="The reason is sent to your homeserver and may be visible to other room clients."
          onOpenChange={onOpenChange}
          onConfirm={(reason) => onConfirm(target, reason)}
        />
      );
    case "report":
      return (
        <ConfirmWithReasonDialog
          open
          title="Report message?"
          description="This sends a report to your homeserver's moderators for review."
          confirmLabel="Report"
          submittingLabel="Reporting…"
          reasonDescription="The reason is sent to your homeserver's moderators."
          onOpenChange={onOpenChange}
          onConfirm={(reason) => onConfirm(target, reason)}
        />
      );
    case "source":
      return (
        <MessageSourceDialog
          open
          roomId={target.roomId}
          eventId={target.eventId}
          onOpenChange={onOpenChange}
        />
      );
    case "history":
      return (
        <EditHistoryDialog
          open
          roomId={target.roomId}
          eventId={target.eventId}
          onOpenChange={onOpenChange}
        />
      );
    case "forward":
      return (
        <ForwardMessageDialog
          open
          sourceRoomId={target.roomId}
          eventId={target.eventId}
          onOpenChange={onOpenChange}
        />
      );
  }
  return null;
}
