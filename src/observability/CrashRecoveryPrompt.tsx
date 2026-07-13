import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface CrashRecoveryPromptProps {
  open: boolean;
  onOpenSettings: () => void;
  onDismiss: () => void;
}

/**
 * One-time nudge shown when {@link checkUncleanPreviousSession} (see
 * `crashRecovery.ts`) reports the previous run didn't shut down cleanly and
 * crash reporting is currently off. Deliberately doesn't offer to "send"
 * anything — there's no captured crash data to send (see that module's doc
 * comment for why), only an invitation to turn on reporting for next time.
 */
export function CrashRecoveryPrompt({ open, onOpenSettings, onDismiss }: CrashRecoveryPromptProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onDismiss()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Charm didn&apos;t close cleanly last time</DialogTitle>
          <DialogDescription>
            Crash reporting is currently off, so we don&apos;t have any details about what happened.
            Turning it on helps us catch problems like this going forward.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onDismiss}>
            Not now
          </Button>
          <Button onClick={onOpenSettings}>Review crash reporting settings</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
