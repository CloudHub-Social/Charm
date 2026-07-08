import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCrossSigningResetUrl } from "@/features/settings/useDevices";
import { useUiaRetry } from "@/features/settings/useUiaRetry";
import { bootstrapCrossSigning } from "@/lib/matrix";

interface VerifyDevicePaneProps {
  onNext: () => void;
  onSkip: () => void;
}

/**
 * Onboarding's nudge into the already-shipped cross-signing bootstrap flow
 * (`DevicesPanel`'s "Set up" action, reused here rather than reimplemented —
 * Spec 12 explicitly forbids new verification UI). This pane itself is only
 * ever mounted by `OnboardingScreen` when the session isn't yet
 * cross-signing-verified; see its `isVerified` check.
 */
export function VerifyDevicePane({ onNext, onSkip }: VerifyDevicePaneProps) {
  const queryClient = useQueryClient();
  const { data: resetUrl } = useCrossSigningResetUrl();
  const [done, setDone] = useState(false);
  const uia = useUiaRetry((password) => bootstrapCrossSigning(password));
  const { needsPassword, password, setPassword, error, submitting } = uia;

  async function handleSetUp() {
    if (await uia.submit()) {
      queryClient.invalidateQueries({ queryKey: ["crossSigningStatus"] });
      setDone(true);
    }
  }

  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
      <h1 className="text-xl font-bold text-foreground">Verify this device</h1>
      {done ? (
        <p className="text-sm text-foreground">This device is set up and trusted.</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Set up cross-signing so your other devices — and the people you talk to — can trust this
            one.
          </p>
          {needsPassword && !resetUrl && (
            <div className="w-full max-w-xs text-left">
              <Label htmlFor="onboarding-verify-password">Account password</Label>
              <Input
                id="onboarding-verify-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {resetUrl ? (
            <Button className="h-11 w-full" onClick={() => openUrl(resetUrl)}>
              Set up in your identity provider
            </Button>
          ) : (
            <Button
              className="h-11 w-full"
              onClick={handleSetUp}
              disabled={submitting || (needsPassword && password === "")}
            >
              {submitting ? "Setting up…" : needsPassword ? "Confirm" : "Verify this device"}
            </Button>
          )}
        </>
      )}
      <Button variant="ghost" className="h-11 w-full" onClick={done ? onNext : onSkip}>
        {done ? "Continue" : "Not now"}
      </Button>
    </div>
  );
}
