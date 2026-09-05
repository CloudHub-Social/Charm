import { useEffect, useState } from "react";
import { useFlag } from "@/featureFlags";
import type { ComposerMode } from "./Composer";
import { PollComposerAction } from "./PollComposerAction";
import { PollDialog } from "./PollDialog";

export function PollComposerControls({
  roomId,
  mode,
  mobile,
  mutationsBlocked,
}: {
  roomId: string;
  mode: ComposerMode;
  mobile: boolean;
  mutationsBlocked: boolean;
}) {
  const enabled = useFlag("polls");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (mutationsBlocked) setOpen(false);
  }, [mutationsBlocked]);

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
      <PollDialog open={open} roomId={roomId} onOpenChange={setOpen} />
    </>
  );
}
