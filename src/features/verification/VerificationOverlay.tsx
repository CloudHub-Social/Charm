import { useEffect, useRef, useState } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useSettingsNavigation } from "@/features/settings/useSettingsNavigation";
import {
  acceptVerificationRequest,
  cancelVerification,
  confirmSasVerification,
  onSasUpdate,
  onVerificationRequest,
  startSasVerification,
  type EmojiPair,
  type VerificationRequestSummary,
} from "@/lib/matrix";
import { avatarColor, initials } from "@/features/rooms/roomDisplay";

type Phase =
  | { kind: "incoming" }
  | { kind: "waiting" }
  | { kind: "comparing"; emojis: EmojiPair[] }
  | { kind: "confirming" }
  | { kind: "done" }
  | { kind: "cancelled"; reason: string };

export function VerificationOverlay() {
  const [request, setRequest] = useState<VerificationRequestSummary | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "incoming" });
  const doneTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { closeSettings } = useSettingsNavigation();

  useEffect(() => {
    const unlisten = onVerificationRequest((incoming) => {
      setRequest(incoming);
      setPhase({ kind: "incoming" });
      // Radix's Dialog applies `aria-hidden` to everything outside its own
      // portal while open (and traps focus there) — this overlay renders as
      // a sibling of the settings dialog, not inside it, so a verification
      // starting while settings is open would otherwise be invisible to
      // assistive tech and unreachable by keyboard despite being visually on
      // top. Closing settings removes that trap instead of trying to work
      // around it (z-index/pointer-events alone don't fix the aria-hidden
      // side of it).
      closeSettings();
    });
    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
    };
  }, [closeSettings]);

  useEffect(() => {
    if (!request) return undefined;
    const unlisten = onSasUpdate(request.flow_id, (update) => {
      switch (update.state) {
        case "started":
        case "accepted":
          setPhase({ kind: "waiting" });
          break;
        case "keys_exchanged":
          setPhase({ kind: "comparing", emojis: update.emojis });
          break;
        case "confirmed":
          setPhase({ kind: "confirming" });
          break;
        case "done":
          setPhase({ kind: "done" });
          doneTimeoutRef.current = setTimeout(() => setRequest(null), 2000);
          break;
        case "cancelled":
          setPhase({ kind: "cancelled", reason: update.reason });
          break;
      }
    });
    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
      // Without this, a "done" auto-dismiss scheduled here can still fire
      // after this effect has torn down — e.g. a new verification request
      // arriving (which changes `request` and reruns this effect) or the
      // component unmounting — and wipe out whatever state came after it.
      if (doneTimeoutRef.current !== null) {
        clearTimeout(doneTimeoutRef.current);
        doneTimeoutRef.current = null;
      }
    };
  }, [request]);

  if (!request) return null;

  async function handleAccept() {
    if (!request) return;
    try {
      await acceptVerificationRequest(request.other_user_id, request.flow_id);
      await startSasVerification(request.other_user_id, request.flow_id);
      setPhase({ kind: "waiting" });
    } catch (err) {
      console.error(err);
      setPhase({ kind: "cancelled", reason: String(err) });
    }
  }

  async function handleDecline() {
    if (!request) return;
    try {
      await cancelVerification(request.other_user_id, request.flow_id);
    } catch (err) {
      console.error(err);
    }
    setRequest(null);
  }

  async function handleConfirm() {
    if (!request) return;
    try {
      await confirmSasVerification(request.other_user_id, request.flow_id);
      setPhase({ kind: "confirming" });
    } catch (err) {
      console.error(err);
      setPhase({ kind: "cancelled", reason: String(err) });
    }
  }

  async function handleNoMatch() {
    if (!request) return;
    try {
      await cancelVerification(request.other_user_id, request.flow_id);
    } catch (err) {
      console.error(err);
    }
    setPhase({ kind: "cancelled", reason: "You indicated the emoji did not match." });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="flex w-90 flex-col items-center gap-4 rounded-lg border border-border bg-card p-6 text-center">
        {phase.kind === "incoming" && (
          <>
            <Avatar size="lg">
              <AvatarFallback
                style={{ background: avatarColor(request.other_user_id) }}
                className="font-bold text-white"
              >
                {initials(request.other_user_id, null)}
              </AvatarFallback>
            </Avatar>
            <p className="text-base font-bold text-foreground">Verify new sign-in</p>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {request.other_user_id} is signing in on a new device and wants to verify with this
              one.
            </p>
            <div className="flex w-full gap-2">
              <Button variant="secondary" className="flex-1" onClick={handleDecline}>
                Decline
              </Button>
              <Button className="flex-1" onClick={handleAccept}>
                Accept
              </Button>
            </div>
          </>
        )}

        {phase.kind === "waiting" && (
          <>
            <Loader />
            <p className="text-base font-bold text-foreground">Waiting for the other device…</p>
            <Button variant="secondary" className="w-full" onClick={handleDecline}>
              Cancel
            </Button>
          </>
        )}

        {phase.kind === "comparing" && (
          <>
            <p className="text-base font-bold text-foreground">Do these emoji match?</p>
            <p className="text-[13px] text-muted-foreground">
              Compare with what's shown on the other device.
            </p>
            <div className="grid w-full grid-cols-4 gap-4">
              {phase.emojis.map((emoji) => (
                <div
                  key={`${emoji.symbol}-${emoji.description}`}
                  className="flex flex-col items-center gap-1"
                >
                  <span className="text-[28px] leading-none">{emoji.symbol}</span>
                  <span className="text-[11px] capitalize text-muted-foreground">
                    {emoji.description}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex w-full gap-2">
              <Button variant="destructive" className="flex-1" onClick={handleNoMatch}>
                They don't match
              </Button>
              <Button className="flex-1" onClick={handleConfirm}>
                They match
              </Button>
            </div>
          </>
        )}

        {phase.kind === "confirming" && (
          <>
            <Loader />
            <p className="text-base font-bold text-foreground">Waiting for the other device…</p>
          </>
        )}

        {phase.kind === "done" && (
          <>
            <span className="text-[32px] leading-none text-success">✓</span>
            <p className="text-base font-bold text-foreground">Verified</p>
            <p className="text-[13px] text-muted-foreground">This device is now trusted.</p>
          </>
        )}

        {phase.kind === "cancelled" && (
          <>
            <span className="text-[32px] leading-none text-destructive">✕</span>
            <p className="text-base font-bold text-foreground">Verification cancelled</p>
            <p className="text-[13px] text-muted-foreground">{phase.reason}</p>
            <Button variant="secondary" className="w-full" onClick={() => setRequest(null)}>
              Dismiss
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function Loader() {
  return (
    <span className="size-5 animate-spin rounded-full border-2 border-border border-t-primary" />
  );
}
