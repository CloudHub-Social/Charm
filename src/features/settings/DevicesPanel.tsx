import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
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
import { bootstrapCrossSigning, type DeviceSummary } from "@/lib/matrix";
import { SettingsCard, SettingTile } from "./components/SettingsCard";
import { DeviceRow } from "./DeviceRow";
import {
  useCrossSigningResetUrl,
  useCrossSigningStatus,
  useDeviceActions,
  useDevices,
} from "./useDevices";
import { useProfile } from "./useProfile";

function groupDevices(devices: DeviceSummary[]) {
  return {
    current: devices.filter((d) => d.is_current),
    verified: devices.filter((d) => !d.is_current && d.is_verified),
    unverified: devices.filter((d) => !d.is_current && !d.is_verified),
  };
}

export function DevicesPanel() {
  const { data: profile } = useProfile();
  const { data: devices } = useDevices();
  const { data: status } = useCrossSigningStatus();
  const { data: resetUrl } = useCrossSigningResetUrl();
  const { revoke, verify, invalidateCrossSigning } = useDeviceActions();
  const usesOAuth = Boolean(profile?.uses_oauth);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkNeedsPassword, setBulkNeedsPassword] = useState(false);
  const [bulkPassword, setBulkPassword] = useState("");
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  // All three keys, not just the master key — an interrupted/reset bootstrap
  // can leave a master key in place without the self-signing/user-signing
  // keys, and this "Set up" action is the only thing that can repair that.
  const isBootstrapped = Boolean(
    status?.has_master_key && status.has_self_signing_key && status.has_user_signing_key,
  );
  const groups = groupDevices(devices ?? []);

  function toggleSelected(deviceId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
  }

  function resetBulk() {
    setBulkNeedsPassword(false);
    setBulkPassword("");
    setBulkError(null);
  }

  async function handleBulkRevoke() {
    setBulkSubmitting(true);
    setBulkError(null);
    const revokePassword = bulkNeedsPassword ? bulkPassword : undefined;
    const remaining: string[] = [];
    let sawUiaChallenge = false;
    for (const deviceId of selectedIds) {
      try {
        await revoke.mutateAsync({ deviceId, password: revokePassword });
      } catch (err) {
        if (!bulkNeedsPassword) {
          sawUiaChallenge = true;
          remaining.push(deviceId);
        } else {
          setBulkError(String(err));
          setBulkSubmitting(false);
          return;
        }
      }
    }
    if (sawUiaChallenge) {
      setSelectedIds(new Set(remaining));
      setBulkNeedsPassword(true);
      setBulkSubmitting(false);
      return;
    }
    setSelectedIds(new Set());
    // Closing programmatically (not via the Dialog's own onOpenChange, which
    // this doesn't go through) skips the reset that a user-driven close
    // gets — without this, the next bulk sign-out would open straight into
    // the stale "needs password" prompt from this run.
    resetBulk();
    setBulkOpen(false);
    setBulkSubmitting(false);
  }

  async function handleBootstrap() {
    setBootstrapping(true);
    setBootstrapError(null);
    try {
      await bootstrapCrossSigning(needsPassword ? password : undefined);
      setNeedsPassword(false);
      setPassword("");
      invalidateCrossSigning();
    } catch (err) {
      if (!needsPassword) {
        setNeedsPassword(true);
      } else {
        setBootstrapError(String(err));
      }
    } finally {
      setBootstrapping(false);
    }
  }

  const selectableIds = [...groups.verified, ...groups.unverified].map((d) => d.device_id);
  const selectedCount = selectedIds.size;

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-lg font-bold text-foreground">Devices</h1>

      <SettingsCard heading="Security">
        <SettingTile>
          <p className="mb-3 text-sm text-muted-foreground">
            {isBootstrapped
              ? "Cross-signing is set up. Verifying another session compares this account's trusted identity."
              : needsPassword
                ? "Re-enter your account password to finish setting up cross-signing."
                : resetUrl
                  ? "Cross-signing isn't set up yet. This account signs in through your identity provider — use the link below to set it up there."
                  : "Cross-signing isn't set up yet. Set it up to be able to verify your other sessions."}
          </p>
          {needsPassword && !isBootstrapped && (
            <div className="mb-3 max-w-xs">
              <Label htmlFor="cross-signing-password">Account password</Label>
              <Input
                id="cross-signing-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          )}
          <div className="flex gap-2">
            {!isBootstrapped && !resetUrl && (
              <Button
                size="sm"
                onClick={handleBootstrap}
                disabled={bootstrapping || (needsPassword && password === "")}
              >
                {bootstrapping ? "Setting up…" : needsPassword ? "Confirm" : "Set up"}
              </Button>
            )}
            {resetUrl && (
              <Button size="sm" variant="outline" onClick={() => openUrl(resetUrl)}>
                {isBootstrapped ? "Reset" : "Set up"}
              </Button>
            )}
          </div>
          {bootstrapError && <p className="mt-2 text-sm text-destructive">{bootstrapError}</p>}
        </SettingTile>
      </SettingsCard>

      {verify.isError && (
        <p className="text-sm text-destructive">
          Couldn't start verification: {String(verify.error)}
        </p>
      )}

      <DeviceGroup
        title="Current"
        devices={groups.current}
        revoke={revoke}
        verify={verify}
        usesOAuth={usesOAuth}
        selectedIds={selectedIds}
        onToggleSelected={toggleSelected}
      />
      <DeviceGroup
        title="Verified"
        devices={groups.verified}
        revoke={revoke}
        verify={verify}
        usesOAuth={usesOAuth}
        selectedIds={selectedIds}
        onToggleSelected={toggleSelected}
      />
      <DeviceGroup
        title="Unverified"
        devices={groups.unverified}
        revoke={revoke}
        verify={verify}
        usesOAuth={usesOAuth}
        selectedIds={selectedIds}
        onToggleSelected={toggleSelected}
      />

      {selectedCount > 0 && (
        <div className="sticky bottom-0 z-10 -mx-6 -mb-6 flex items-center justify-between border-t border-border bg-background p-4 shadow-lg">
          <span className="text-sm text-foreground">
            {selectedCount} device{selectedCount === 1 ? "" : "s"} selected
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
              Clear
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setBulkOpen(true)}
              disabled={!selectableIds.some((id) => selectedIds.has(id))}
            >
              Sign out selected
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={bulkOpen}
        onOpenChange={(next) => {
          if (!next) resetBulk();
          setBulkOpen(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign out {selectedCount} devices?</DialogTitle>
            <DialogDescription>
              {bulkNeedsPassword
                ? "Re-enter your password to confirm."
                : "This immediately signs out every selected device."}
            </DialogDescription>
          </DialogHeader>
          {bulkNeedsPassword && (
            <div>
              <Label htmlFor="bulk-revoke-password">Current password</Label>
              <Input
                id="bulk-revoke-password"
                type="password"
                value={bulkPassword}
                onChange={(e) => setBulkPassword(e.target.value)}
              />
            </div>
          )}
          {bulkError && <p className="text-sm text-destructive">{bulkError}</p>}
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                resetBulk();
                setBulkOpen(false);
              }}
              disabled={bulkSubmitting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleBulkRevoke}
              disabled={bulkSubmitting || (bulkNeedsPassword && bulkPassword === "")}
            >
              {bulkSubmitting ? "Signing out…" : "Sign out"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DeviceGroup({
  title,
  devices,
  revoke,
  verify,
  usesOAuth,
  selectedIds,
  onToggleSelected,
}: {
  title: string;
  devices: DeviceSummary[];
  revoke: ReturnType<typeof useDeviceActions>["revoke"];
  verify: ReturnType<typeof useDeviceActions>["verify"];
  usesOAuth: boolean;
  selectedIds: Set<string>;
  onToggleSelected: (deviceId: string) => void;
}) {
  if (devices.length === 0) return null;

  return (
    <SettingsCard heading={title}>
      {devices.map((device) => (
        <DeviceRow
          key={device.device_id}
          device={device}
          usesOAuth={usesOAuth}
          onVerify={() => verify.mutateAsync(device.device_id)}
          onRevoke={(password) => revoke.mutateAsync({ deviceId: device.device_id, password })}
          selection={
            device.is_current || usesOAuth
              ? undefined
              : {
                  selected: selectedIds.has(device.device_id),
                  onToggle: () => onToggleSelected(device.device_id),
                }
          }
        />
      ))}
    </SettingsCard>
  );
}
