import { useState } from "react";
import { useFlag } from "@/featureFlags";
import type { ComposerMode } from "./Composer";
import { PollComposerAction } from "./PollComposerAction";
import { PollDialog } from "./PollDialog";

export function PollComposerControls({
  roomId,
  mode,
  mobile,
  mutationsBlocked,
  startSend,
}: {
  roomId: string;
  mode: ComposerMode;
  mobile: boolean;
  mutationsBlocked: boolean;
  startSend?: () => (() => void) | null;
}) {
  const enabled = useFlag("polls");
  const [open, setOpen] = useState(false);

  if (!enabled) return null;
  return (
    <>
      {mode === "send" && (
        <PollComposerAction
          mobile={mobile}
          disabled={mutationsBlocked}
          onClick={() => setOpen(true)}
        />
      )}
      <PollDialog
        open={open}
        roomId={roomId}
        mutationsBlocked={mutationsBlocked}
        startSend={startSend}
        onOpenChange={setOpen}
      />
    </>
  );
}
