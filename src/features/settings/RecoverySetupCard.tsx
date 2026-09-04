import { useRef, useState } from "react";
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
import { setupRecovery } from "@/lib/matrix";
import { SettingsCard, SettingTile } from "./components/SettingsCard";
import { RECOVERY_STATUS_QUERY_KEY } from "./useDevices";

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
  const [setupPending, setSetupPending] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [roomKeysBackedUp, setRoomKeysBackedUp] = useState(true);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const hasPassphrase = passphrase.length > 0;
  const passphraseValid =
    (!hasPassphrase && confirmation.length === 0) ||
    (Array.from(passphrase).length >= 8 &&
      new TextEncoder().encode(passphrase).length <= 1024 &&
      confirmation === passphrase);

  async function startSetup() {
    if (!enabled || setupInFlight.current || !passphraseValid || !crossSigningReady) return;
    setupInFlight.current = true;
    setSetupPending(true);
    setSetupError(null);
    try {
      const summary = await setupRecovery(hasPassphrase ? passphrase : undefined);
      setSetupOpen(false);
      setRoomKeysBackedUp(summary.room_keys_backed_up);
      setRecoveryKey(summary.recovery_key);
    } catch {
      setSetupError("Could not set up recovery. Please try again.");
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

  function finish() {
    if (!saved) return;
    setRecoveryKey(null);
    setSaved(false);
    setCopied(false);
    setRoomKeysBackedUp(true);
    void queryClient.invalidateQueries({ queryKey: RECOVERY_STATUS_QUERY_KEY });
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
          if (!open) finish();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save your recovery key</DialogTitle>
            <DialogDescription>
              Store this somewhere safe and separate from this device. Charm cannot recover it for
              you after this window closes.
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
            <Button onClick={finish} disabled={!saved}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
