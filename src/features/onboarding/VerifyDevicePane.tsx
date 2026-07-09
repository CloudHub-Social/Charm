import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useCrossSigningResetUrl,
  useCrossSigningStatus,
  useDeviceActions,
  useDevices,
} from "@/features/settings/useDevices";
import { useUiaRetry } from "@/features/settings/useUiaRetry";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { bootstrapCrossSigning } from "@/lib/matrix";
import { openExternalUrl } from "@/lib/openExternalUrl";

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
  const { data: devices } = useDevices();
  const { data: crossSigningStatus } = useCrossSigningStatus();
  const { data: resetUrl } = useCrossSigningResetUrl();
  const { verify, invalidateDevices, invalidateCrossSigning } = useDeviceActions();
  const [done, setDone] = useState(false);
  const uia = useUiaRetry((password) => bootstrapCrossSigning(password));
  const { needsPassword, password, setPassword, error, submitting } = uia;
  const isBootstrapped = Boolean(
    crossSigningStatus?.has_master_key &&
    crossSigningStatus.has_self_signing_key &&
    crossSigningStatus.has_user_signing_key,
  );
  const verifierDevices = (devices ?? []).filter((device) => !device.is_current);
  const canVerifyWithAnotherDevice = isBootstrapped && verifierDevices.length > 0;

  async function handleSetUp() {
    if (await uia.submit()) {
      invalidateCrossSigning();
      setDone(true);
    }
  }

  async function handleVerifyWith(deviceId: string) {
    await verify.mutateAsync(deviceId);
  }

  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
      <h1 className="text-xl font-bold text-foreground">Verify this device</h1>
      {done ? (
        <p className="text-sm text-foreground">This device is set up and trusted.</p>
      ) : canVerifyWithAnotherDevice ? (
        <>
          <p className="text-sm text-muted-foreground">
            Choose a session you already trust, then compare emojis there to verify this sign-in.
          </p>
          {verifierDevices.length > 0 ? (
            <div className="flex w-full flex-col gap-2">
              {verifierDevices.map((device) => (
                <Button
                  key={device.device_id}
                  className="h-11 w-full"
                  onClick={() => handleVerifyWith(device.device_id).catch(logAndIgnore)}
                  disabled={verify.isPending}
                >
                  Verify with {device.display_name ?? device.device_id}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Open Charm on a trusted session, then come back here to start verification.
            </p>
          )}
          {verify.isError && (
            <p className="text-sm text-destructive">
              Couldn't start verification: {String(verify.error)}
            </p>
          )}
          <Button
            variant="ghost"
            className="h-11 w-full"
            onClick={() => {
              invalidateDevices();
              invalidateCrossSigning();
            }}
          >
            Check again
          </Button>
        </>
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
            <Button
              className="h-11 w-full"
              onClick={() => openExternalUrl(resetUrl).catch(logAndIgnore)}
            >
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
          {verifierDevices.length > 0 && (
            <Button
              variant="ghost"
              className="h-11 w-full"
              onClick={() => {
                invalidateDevices();
                invalidateCrossSigning();
              }}
            >
              Check again
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
