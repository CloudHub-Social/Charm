import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useCrossSigningStatus } from "@/features/settings/useDevices";
import { OrientationPane } from "./OrientationPane";
import { ProfilePane } from "./ProfilePane";
import { VerifyDevicePane } from "./VerifyDevicePane";

interface OnboardingScreenProps {
  onDone: () => void;
}

type PaneKey = "orientation" | "verify" | "profile";

/**
 * First-run orientation surface — a full-screen overlay (not a modal inside
 * `RoomsScreen`) so it renders before the room-list machinery mounts. See
 * `App.tsx`'s module doc comment for why it slots in as its own branch
 * rather than living inside `RoomsScreen`.
 *
 * Max 3 panes, every one skippable (Spec 12's R2 guard rail against scope
 * creep into a wizard): the verify pane is entirely omitted — not just
 * hidden — once cross-signing is already set up, so a returning-ish account
 * that still happens to have zero rooms doesn't see a pane with nothing to
 * do.
 */
export function OnboardingScreen({ onDone }: OnboardingScreenProps) {
  const { data: crossSigningStatus } = useCrossSigningStatus();
  const isVerified = Boolean(
    crossSigningStatus?.has_master_key &&
    crossSigningStatus.has_self_signing_key &&
    crossSigningStatus.has_user_signing_key,
  );

  const panes = useMemo<PaneKey[]>(() => {
    const list: PaneKey[] = ["orientation"];
    if (!isVerified) list.push("verify");
    list.push("profile");
    return list;
  }, [isVerified]);

  const [index, setIndex] = useState(0);
  // Clamped rather than reset: if the verify pane disappears out from under
  // the user mid-flow (status resolves as "already verified" after they'd
  // already moved past orientation), this keeps them on the same logical
  // step instead of snapping back to the start.
  const clampedIndex = Math.min(index, panes.length - 1);
  const pane = panes[clampedIndex];

  function next() {
    if (clampedIndex >= panes.length - 1) {
      onDone();
    } else {
      setIndex(clampedIndex + 1);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background">
      <div className="flex justify-end p-4">
        <Button variant="ghost" size="sm" className="h-11" onClick={onDone}>
          Skip
        </Button>
      </div>
      <div className="motion-safe:transition-opacity motion-safe:duration-200 flex flex-1 items-center justify-center p-6">
        {pane === "orientation" && <OrientationPane onNext={next} />}
        {pane === "verify" && <VerifyDevicePane onNext={next} onSkip={onDone} />}
        {pane === "profile" && <ProfilePane onNext={next} onSkip={onDone} />}
      </div>
      <div className="flex justify-center gap-2 pb-8" aria-hidden>
        {panes.map((p) => (
          <span
            key={p}
            className={`size-1.5 rounded-full ${p === pane ? "bg-foreground" : "bg-border"}`}
          />
        ))}
      </div>
    </div>
  );
}
