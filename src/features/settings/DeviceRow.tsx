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
import type { DeviceSummary } from "@/lib/matrix";

function formatLastSeen(ts: number | null): string | null {
  if (ts === null) return null;
  return new Date(ts).toLocaleString();
}

interface DeviceRowProps {
  device: DeviceSummary;
  onVerify: () => void;
  /** UIA-gated — throw on the first (password-less) attempt to trigger the retry prompt. */
  onRevoke: (password?: string) => Promise<void>;
  verifying?: boolean;
}

export function DeviceRow({ device, onVerify, onRevoke, verifying }: DeviceRowProps) {
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const label = device.display_name ?? device.device_id;
  const lastSeen = formatLastSeen(device.last_seen_ts);

  function reset() {
    setNeedsPassword(false);
    setPassword("");
    setError(null);
  }

  async function handleRevoke() {
    setSubmitting(true);
    setError(null);
    try {
      await onRevoke(needsPassword ? password : undefined);
      setRevokeOpen(false);
    } catch {
      if (!needsPassword) {
        setNeedsPassword(true);
      } else {
        setError("Incorrect password. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-4 py-3">
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
                : "rounded-full bg-destructive/15 px-2 py-0.5 text-[11px] text-destructive"
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

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${label}`}>
            ⋮
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!device.is_verified && !device.is_current && (
            <DropdownMenuItem onClick={onVerify} disabled={verifying}>
              Verify
            </DropdownMenuItem>
          )}
          {!device.is_current && (
            <DropdownMenuItem variant="destructive" onClick={() => setRevokeOpen(true)}>
              Sign out
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

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
            <Button variant="secondary" onClick={() => setRevokeOpen(false)} disabled={submitting}>
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
