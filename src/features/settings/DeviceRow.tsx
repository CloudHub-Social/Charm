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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { logAndIgnore } from "@/lib/logAndIgnore";
import type { DeviceSummary } from "@/lib/matrix";
import { openExternalUrl } from "@/lib/openExternalUrl";
import { useDeviceDeleteUrl } from "./useDevices";
import { useUiaRetry } from "./useUiaRetry";

function formatLastSeen(ts: number | null): string | null {
  if (ts === null) return null;
  return new Date(ts).toLocaleString();
}

interface DeviceRowProps {
  device: DeviceSummary;
  /** Returns a promise so this row can track its own in-flight state, independent of every other row's. */
  onVerify: () => Promise<unknown>;
  /** UIA-gated — throw on the first (password-less) attempt to trigger the retry prompt. */
  onRevoke: (password?: string) => Promise<void>;
  /**
   * Whether the current session is OAuth/OIDC-managed — see the Rust
   * command's doc comment on `get_device_delete_url`. `undefined` while the
   * profile that determines this is still loading: the in-app "Sign out"
   * and the "Manage in account settings" link are mutually exclusive and
   * gated on this being known, so both are hidden until it resolves rather
   * than defaulting to the non-OAuth ("Sign out") behavior.
   */
  usesOAuth: boolean | undefined;
  /** Bulk-select checkbox — omitted (no checkbox rendered) for the current device, which can't be bulk-revoked. */
  selection?: { selected: boolean; onToggle: () => void };
}

export function DeviceRow({ device, onVerify, onRevoke, usesOAuth, selection }: DeviceRowProps) {
  const { data: deleteUrl } = useDeviceDeleteUrl(device.device_id, Boolean(usesOAuth));
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const uia = useUiaRetry((password) => onRevoke(password));
  const { needsPassword, password, setPassword, error, submitting } = uia;

  const label = device.display_name ?? device.device_id;
  const lastSeen = formatLastSeen(device.last_seen_ts);

  function reset() {
    uia.reset();
  }

  async function handleVerify() {
    setVerifying(true);
    try {
      await onVerify();
    } finally {
      setVerifying(false);
    }
  }

  async function handleRevoke() {
    if (await uia.submit()) setRevokeOpen(false);
  }

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        {selection && (
          <input
            type="checkbox"
            aria-label={`Select ${label}`}
            checked={selection.selected}
            onChange={selection.onToggle}
          />
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{label}</span>
            {device.is_current && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                This device
              </span>
            )}
            <span
              className={
                device.is_verified
                  ? "rounded-full bg-success/15 px-2 py-0.5 text-[11px] text-success"
                  : "rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive"
              }
            >
              {device.is_verified ? "Verified" : "Unverified"}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {device.device_id}
            {device.last_seen_ip && ` · ${device.last_seen_ip}`}
            {lastSeen && ` · Last seen ${lastSeen}`}
          </p>
        </div>
      </div>

      {!device.is_current && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${label}`}>
              ⋮
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {!device.is_verified && (
              <DropdownMenuItem onClick={handleVerify} disabled={verifying}>
                Verify
              </DropdownMenuItem>
            )}
            {/* `delete_device`'s password-only UIA retry can't satisfy an
                OAuth-managed session's challenge — for those, offer the
                account-management deep link (once resolved) instead of an
                in-app "Sign out" that can never complete. Both branches below
                require `usesOAuth` to be resolved (not `undefined`) before
                rendering either action. */}
            {usesOAuth === false && (
              <DropdownMenuItem variant="destructive" onClick={() => setRevokeOpen(true)}>
                Sign out
              </DropdownMenuItem>
            )}
            {usesOAuth === true && deleteUrl && (
              <DropdownMenuItem onClick={() => openExternalUrl(deleteUrl).catch(logAndIgnore)}>
                Manage in account settings
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <Dialog
        open={revokeOpen}
        onOpenChange={(next) => {
          if (!next) reset();
          setRevokeOpen(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign out this device?</DialogTitle>
            <DialogDescription>
              {needsPassword
                ? "Re-enter your password to confirm."
                : `This immediately signs "${label}" out.`}
            </DialogDescription>
          </DialogHeader>
          {needsPassword && (
            <div>
              <Label htmlFor={`revoke-password-${device.device_id}`}>Current password</Label>
              <Input
                id={`revoke-password-${device.device_id}`}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                reset();
                setRevokeOpen(false);
              }}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRevoke}
              disabled={submitting || (needsPassword && password === "")}
            >
              {submitting ? "Signing out…" : "Sign out"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
