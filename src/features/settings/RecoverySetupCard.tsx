import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { acknowledgeRecoverySetup, getPendingRecoverySetup, setupRecovery } from "@/lib/matrix";
import { SettingsCard, SettingTile } from "./components/SettingsCard";
import { RECOVERY_STATUS_QUERY_KEY } from "./useDevices";

function setupFailureGuidance(error: unknown): string {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  // Only map known conditions to static copy; never render an arbitrary native,
  // server, keychain, or credential-bearing diagnostic.
  if (message.includes("Sign in again") || message.includes("persisted session is no longer")) {
    return "Sign in again with durable encrypted storage before setting up recovery.";
  }
  if (message.includes("not enabled")) {
    return "Recovery setup is not enabled for this app or server. Contact your administrator.";
  }
  if (/protected|Protected|storage|snapshot|crypto store/.test(message)) {
    return "Protected recovery storage is unavailable. Check device access or ask your server administrator to configure durable encrypted storage before retrying.";
  }
  return "Could not set up recovery. Check your connection and cross-signing, then try again.";
}

export function RecoverySetupCard({
  enabled,
  crossSigningReady,
  recoveryDisabled,
}: {
  enabled: boolean;
  crossSigningReady: boolean;
  recoveryDisabled: boolean;
}) {
  const queryClient = useQueryClient();
  // Do not place credentials in TanStack's mutation variables/data cache.
  const setupInFlight = useRef(false);
  const requestGeneration = useRef(0);
  const acknowledgementInFlight = useRef(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const [acknowledgementError, setAcknowledgementError] = useState<string | null>(null);
  const [pendingReadError, setPendingReadError] = useState(false);
  const [setupPending, setSetupPending] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [roomKeysBackedUp, setRoomKeysBackedUp] = useState(true);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    const generation = requestGeneration.current;
    void getPendingRecoverySetup()
      .then((summary) => {
        if (!active || generation !== requestGeneration.current || !summary) return;
        setRecoveryKey(summary.recovery_key);
        setRoomKeysBackedUp(summary.room_keys_backed_up);
      })
      .catch(() => {
        if (active && generation === requestGeneration.current) setPendingReadError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const hasPassphrase = passphrase.length > 0;
  const passphraseValid =
    (!hasPassphrase && confirmation.length === 0) ||
    (Array.from(passphrase).length >= 8 &&
      new TextEncoder().encode(passphrase).length <= 1024 &&
      confirmation === passphrase);

  async function startSetup() {
    if (!enabled || setupInFlight.current || !passphraseValid || !crossSigningReady) return;
    setupInFlight.current = true;
    requestGeneration.current += 1;
    setPendingReadError(false);
    setSetupPending(true);
    setSetupError(null);
    try {
      const summary = await setupRecovery(hasPassphrase ? passphrase : undefined);
      setSetupOpen(false);
      setRoomKeysBackedUp(summary.room_keys_backed_up);
      setRecoveryKey(summary.recovery_key);
    } catch (error) {
      setSetupError(setupFailureGuidance(error));
    } finally {
      setPassphrase("");
      setConfirmation("");
      setupInFlight.current = false;
      setSetupPending(false);
    }
  }

  function closeSetup() {
    if (setupInFlight.current) return;
    setSetupOpen(false);
    setPassphrase("");
    setConfirmation("");
    setSetupError(null);
  }

  async function finish() {
    if (!saved || !recoveryKey || acknowledgementInFlight.current) return;
    acknowledgementInFlight.current = true;
    setAcknowledging(true);
    setAcknowledgementError(null);
    try {
      await acknowledgeRecoverySetup(recoveryKey);
      requestGeneration.current += 1;
      setRecoveryKey(null);
      setSaved(false);
      setCopied(false);
      setRoomKeysBackedUp(true);
      void queryClient.invalidateQueries({ queryKey: RECOVERY_STATUS_QUERY_KEY });
    } catch {
      setAcknowledgementError("Could not acknowledge your saved key. Keep it safe and try again.");
    } finally {
      acknowledgementInFlight.current = false;
      setAcknowledging(false);
    }
  }

  function copyRecoveryKey() {
    if (!recoveryKey || !navigator.clipboard?.writeText) return;
    navigator.clipboard
      .writeText(recoveryKey)
      .then(() => setCopied(true))
      .catch(logAndIgnore);
  }

  return (
    <>
      {pendingReadError && (
        <p role="alert">
          Could not reopen pending recovery. Reopen Settings when online before signing out.
        </p>
      )}
      {enabled && recoveryDisabled && (
        <SettingsCard heading="Recovery">
          <SettingTile>
            <p className="mb-3 text-sm text-muted-foreground">
              Protect encrypted message history by creating Matrix secret storage and a server-side
              room-key backup. Charm will give you a recovery key to save offline.
            </p>
            {!crossSigningReady && (
              <p className="mb-3 text-sm text-muted-foreground">
                Set up or restore cross-signing above before enabling recovery.
              </p>
            )}
            <Button size="sm" onClick={() => setSetupOpen(true)} disabled={!crossSigningReady}>
              Set up recovery
            </Button>
          </SettingTile>
        </SettingsCard>
      )}

      <Dialog
        open={setupOpen}
        onOpenChange={(open) => {
          if (!open) closeSetup();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set up recovery</DialogTitle>
            <DialogDescription>
              Charm will create a server-side encrypted room-key backup. You can optionally add a
              passphrase, but you must save the generated recovery key either way.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="recovery-setup-passphrase">Optional passphrase</Label>
              <Input
                id="recovery-setup-passphrase"
                type="password"
                autoComplete="new-password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="recovery-setup-confirmation">Confirm passphrase</Label>
              <Input
                id="recovery-setup-confirmation"
                type="password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </div>
            {setupError && <p className="text-sm text-destructive">{setupError}</p>}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={closeSetup} disabled={setupPending}>
              Cancel
            </Button>
            <Button
              onClick={() => startSetup().catch(logAndIgnore)}
              disabled={!enabled || !passphraseValid || setupPending}
            >
              {setupPending ? "Backing up room keys…" : "Create backup"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={recoveryKey !== null}
        onOpenChange={(open) => {
          if (!open) void finish();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save your recovery key</DialogTitle>
            <DialogDescription>
              Store this somewhere safe and separate from this device. Until you confirm, Charm
              retains a protected pending copy across app or page restarts. Save it before signing
              out or removing this device's data.
            </DialogDescription>
          </DialogHeader>
          <pre className="overflow-x-auto rounded-md border border-border bg-muted p-3 text-sm whitespace-pre-wrap">
            {recoveryKey}
          </pre>
          {!roomKeysBackedUp && (
            <p className="text-sm text-destructive" role="alert">
              Recovery is enabled, but some room keys could not be uploaded yet. Keep Charm open and
              online so it can retry the backup.
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={copyRecoveryKey}>
              Copy recovery key
            </Button>
            {copied && <output className="text-sm text-muted-foreground">Copied</output>}
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              className="mt-0.5"
              type="checkbox"
              checked={saved}
              onChange={(event) => setSaved(event.target.checked)}
            />
            I saved this recovery key somewhere safe.
          </label>
          <DialogFooter>
            {acknowledgementError && <p role="alert">{acknowledgementError}</p>}
            <Button onClick={() => void finish()} disabled={!saved || acknowledging}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
