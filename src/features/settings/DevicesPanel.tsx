import { useEffect, useState } from "react";
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
import { bootstrapCrossSigning, type DeviceSummary } from "@/lib/matrix";
import { openExternalUrl } from "@/lib/openExternalUrl";
import { SettingsCard, SettingTile } from "./components/SettingsCard";
import { DeviceRow } from "./DeviceRow";
import {
  useCrossSigningResetUrl,
  useCrossSigningStatus,
  useDeviceActions,
  useDevices,
} from "./useDevices";
import { useProfile } from "./useProfile";
import { isUiaCommandError, uiaErrorMessage, useUiaRetry } from "./useUiaRetry";

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
  const { revoke, verify, invalidateDevices, invalidateCrossSigning } = useDeviceActions();
  const oauthKnown = profile !== undefined;
  const usesOAuth = Boolean(profile?.uses_oauth);
  // `profile` (and so `usesOAuth`) is undefined until its query resolves —
  // without requiring it to have loaded, a deep-linked Devices panel could
  // briefly render selection checkboxes for what turns out to be an OAuth
  // account (whose devices can only be revoked via account management, not
  // in-app), with selections surviving the moment `usesOAuth` flips to true.
  // Treating "still loading" as non-selectable closes that window entirely.
  const canBulkSelect = oauthKnown && !usesOAuth;
  // Same reasoning applies to each row's own actions: while `profile` is
  // still loading, `usesOAuth`'s default-`false` value would otherwise leak
  // through as "not OAuth, safe to show in-app Sign out" — for an
  // OAuth-managed web session that action can never complete (its UIA retry
  // is password-only), so a quick click just fails confusingly. Passing
  // `undefined` until the profile resolves keeps both the in-app "Sign out"
  // and the account-management link out of the menu during that window.
  const rowUsesOAuth = oauthKnown ? usesOAuth : undefined;
  const uia = useUiaRetry((password) => bootstrapCrossSigning(password));
  const {
    needsPassword,
    password,
    setPassword,
    error: bootstrapError,
    submitting: bootstrapping,
  } = uia;

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkNeedsPassword, setBulkNeedsPassword] = useState(false);
  const [bulkPassword, setBulkPassword] = useState("");
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  // `has_identity` covers the case onboarding already handles: the account's
  // cross-signing identity exists (set up from another session) but this
  // session hasn't downloaded/verified the private keys locally yet. Without
  // it, this tile would fall through to the local-keys-only check below,
  // wrongly claim "Cross-signing isn't set up yet", and offer setup/reset
  // instead of verification from a trusted session.
  //
  // The local-keys check still matters on its own: all three keys, not just
  // the master key — an interrupted/reset bootstrap can leave a master key
  // in place without the self-signing/user-signing keys, and this "Set up"
  // action is the only thing that can repair that.
  const isBootstrapped = Boolean(
    status?.has_identity ||
      (status?.has_master_key && status.has_self_signing_key && status.has_user_signing_key),
  );
  const groups = groupDevices(devices ?? []);
  const selectableDeviceIds = [...groups.verified, ...groups.unverified].map((d) => d.device_id);

  // Prunes selectedIds whenever the device list changes underneath it — a
  // device can leave the selectable set without going through toggleSelected
  // at all: signing it out from its own row menu, another session revoking
  // it, or a refetch simply dropping it. Without this, the action bar's
  // count and the bulk-revoke loop would both keep sending an id for a
  // device that no longer exists (or no longer qualifies).
  useEffect(() => {
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => selectableDeviceIds.includes(id)));
      return next.size === prev.size ? prev : next;
    });
    // Only the device list itself should trigger a prune — reacting to
    // `selectableDeviceIds` (a new array every render) would run this on
    // every render instead of only when `devices` actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices]);

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
    const succeeded = new Set<string>();
    const remaining: string[] = [];
    let sawUiaChallenge = false;
    for (const deviceId of selectedIds) {
      try {
        await revoke.mutateAsync({ deviceId, password: revokePassword });
        succeeded.add(deviceId);
      } catch (err) {
        if (!bulkNeedsPassword && isUiaCommandError(err) && err.kind === "UiaChallenge") {
          sawUiaChallenge = true;
          remaining.push(deviceId);
        } else {
          // Devices already revoked earlier in this loop must drop out of
          // the selection even though the batch as a whole failed here —
          // otherwise the dialog reopens still showing them as selected
          // (and a retry would try to revoke them a second time).
          setSelectedIds((prev) => {
            const next = new Set(prev);
            for (const id of succeeded) next.delete(id);
            return next;
          });
          setBulkError(uiaErrorMessage(err));
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
    if (await uia.submit()) {
      uia.reset();
      // The current device's `is_verified` is now derived from cross-signing
      // verification, so the devices cache also needs invalidating here —
      // otherwise it can serve a stale "Unverified" row for up to the 30s
      // stale window right after a successful setup.
      invalidateDevices();
      invalidateCrossSigning();
    }
  }

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
              <Button
                size="sm"
                variant="outline"
                onClick={() => openExternalUrl(resetUrl).catch(logAndIgnore)}
              >
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
        usesOAuth={rowUsesOAuth}
        canSelect={canBulkSelect}
        selectedIds={selectedIds}
        onToggleSelected={toggleSelected}
      />
      <DeviceGroup
        title="Verified"
        devices={groups.verified}
        revoke={revoke}
        verify={verify}
        usesOAuth={rowUsesOAuth}
        canSelect={canBulkSelect}
        selectedIds={selectedIds}
        onToggleSelected={toggleSelected}
      />
      <DeviceGroup
        title="Unverified"
        devices={groups.unverified}
        revoke={revoke}
        verify={verify}
        usesOAuth={rowUsesOAuth}
        canSelect={canBulkSelect}
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
              disabled={!selectableDeviceIds.some((id) => selectedIds.has(id))}
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
            <DialogTitle>
              Sign out {selectedCount} device{selectedCount === 1 ? "" : "s"}?
            </DialogTitle>
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
  canSelect,
  selectedIds,
  onToggleSelected,
}: {
  title: string;
  devices: DeviceSummary[];
  revoke: ReturnType<typeof useDeviceActions>["revoke"];
  verify: ReturnType<typeof useDeviceActions>["verify"];
  usesOAuth: boolean | undefined;
  canSelect: boolean;
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
            device.is_current || !canSelect
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
