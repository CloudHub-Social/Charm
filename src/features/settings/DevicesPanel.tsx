import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { bootstrapCrossSigning, type DeviceSummary } from "@/lib/matrix";
import { DeviceRow } from "./DeviceRow";
import {
  useCrossSigningResetUrl,
  useCrossSigningStatus,
  useDeviceActions,
  useDevices,
} from "./useDevices";
import { useProfile } from "./useProfile";
import { useUiaRetry } from "./useUiaRetry";

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
  const uia = useUiaRetry((password) => bootstrapCrossSigning(password));
  const {
    needsPassword,
    password,
    setPassword,
    error: bootstrapError,
    submitting: bootstrapping,
  } = uia;

  // All three keys, not just the master key — an interrupted/reset bootstrap
  // can leave a master key in place without the self-signing/user-signing
  // keys, and this "Set up" action is the only thing that can repair that.
  const isBootstrapped = Boolean(
    status?.has_master_key && status.has_self_signing_key && status.has_user_signing_key,
  );
  const groups = groupDevices(devices ?? []);

  async function handleBootstrap() {
    if (await uia.submit()) {
      uia.reset();
      invalidateCrossSigning();
    }
  }

  return (
    <div className="max-w-lg space-y-6">
      <section className="rounded-lg border border-border p-4">
        <h2 className="mb-1 text-sm font-bold text-foreground">Cross-signing</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          {isBootstrapped
            ? "Set up. Verifying another session compares this account's trusted identity."
            : needsPassword
              ? "Re-enter your account password to finish setting up cross-signing."
              : resetUrl
                ? "Not set up yet. This account signs in through your identity provider — use the link below to set it up there."
                : "Not set up yet. Set it up to be able to verify your other sessions."}
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
          {/* `resetUrl` is only ever populated for OAuth/OIDC sessions (see
              `get_cross_signing_reset_url`), which `bootstrapCrossSigning`'s
              password-only UIA retry can never satisfy — the account
              management URL below is the only path that works there, so the
              in-app "Set up" flow is only offered when it isn't OAuth. */}
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
      </section>

      {verify.isError && (
        <p className="text-sm text-destructive">
          Couldn't start verification: {String(verify.error)}
        </p>
      )}

      <DeviceGroup
        title="This device"
        devices={groups.current}
        revoke={revoke}
        verify={verify}
        usesOAuth={usesOAuth}
      />
      <DeviceGroup
        title="Verified"
        devices={groups.verified}
        revoke={revoke}
        verify={verify}
        usesOAuth={usesOAuth}
      />
      <DeviceGroup
        title="Unverified"
        devices={groups.unverified}
        revoke={revoke}
        verify={verify}
        usesOAuth={usesOAuth}
      />
    </div>
  );
}

function DeviceGroup({
  title,
  devices,
  revoke,
  verify,
  usesOAuth,
}: {
  title: string;
  devices: DeviceSummary[];
  revoke: ReturnType<typeof useDeviceActions>["revoke"];
  verify: ReturnType<typeof useDeviceActions>["verify"];
  usesOAuth: boolean;
}) {
  if (devices.length === 0) return null;

  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold text-muted-foreground uppercase">{title}</h3>
      <div className="divide-y divide-border">
        {devices.map((device) => (
          <DeviceRow
            key={device.device_id}
            device={device}
            usesOAuth={usesOAuth}
            onVerify={() => verify.mutateAsync(device.device_id)}
            onRevoke={(password) => revoke.mutateAsync({ deviceId: device.device_id, password })}
          />
        ))}
      </div>
    </section>
  );
}
