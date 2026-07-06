import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { changePassword, deactivateAccount, logout } from "@/lib/matrix";
import { useProfile, useResolvedAvatarSrc, useUpdateProfile } from "./useProfile";

interface AccountPanelProps {
  onLoggedOut: () => void;
}

export function AccountPanel({ onLoggedOut }: AccountPanelProps) {
  const { data: profile } = useProfile();
  const { updateDisplayName, updateAvatar } = useUpdateProfile();
  const avatarSrc = useResolvedAvatarSrc(profile?.avatar_url);

  const [displayNameDraft, setDisplayNameDraft] = useState<string | null>(null);
  const displayName = displayNameDraft ?? profile?.display_name ?? "";

  const [logoutOpen, setLogoutOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);

  async function handleSaveDisplayName() {
    try {
      await updateDisplayName.mutateAsync(displayName.trim() === "" ? null : displayName.trim());
      setDisplayNameDraft(null);
    } catch {
      // Surfaced via `updateDisplayName.error` below; keep the draft so the
      // user's edit isn't lost.
    }
  }

  async function handlePickAvatar() {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    });
    if (typeof selected !== "string") return;
    try {
      await updateAvatar.mutateAsync(selected);
    } catch {
      // Surfaced via `updateAvatar.error` below.
    }
  }

  async function handleLogout() {
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await logout();
      setLogoutOpen(false);
      onLoggedOut();
    } catch (err) {
      setLogoutError(String(err));
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <div className="max-w-md space-y-8">
      <section>
        <h2 className="mb-4 text-lg font-bold text-foreground">Profile</h2>
        <div className="mb-4 flex items-center gap-4">
          <Avatar size="lg">
            {avatarSrc && <AvatarImage src={avatarSrc} alt="" />}
            <AvatarFallback>
              {(profile?.display_name ?? profile?.user_id ?? "?").slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <Button
            variant="outline"
            size="sm"
            onClick={handlePickAvatar}
            disabled={updateAvatar.isPending}
          >
            Change avatar
          </Button>
        </div>
        {updateAvatar.isError && (
          <p className="mb-2 text-sm text-destructive">{String(updateAvatar.error)}</p>
        )}
        <Label htmlFor="display-name">Display name</Label>
        <div className="mt-1 flex gap-2">
          <Input
            id="display-name"
            value={displayName}
            onChange={(e) => setDisplayNameDraft(e.target.value)}
          />
          <Button
            onClick={handleSaveDisplayName}
            disabled={updateDisplayName.isPending || displayNameDraft === null}
          >
            Save
          </Button>
        </div>
        {updateDisplayName.isError && (
          <p className="mt-2 text-sm text-destructive">{String(updateDisplayName.error)}</p>
        )}
        {profile?.user_id && (
          <p className="mt-2 text-xs text-muted-foreground">{profile.user_id}</p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-bold text-foreground">Password</h2>
        <Button variant="outline" onClick={() => setPasswordDialogOpen(true)}>
          Change password
        </Button>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-bold text-foreground">Sign out</h2>
        <Button variant="outline" onClick={() => setLogoutOpen(true)}>
          Log out
        </Button>
      </section>

      <section className="space-y-2 border-t border-border pt-6">
        <h2 className="text-lg font-bold text-destructive">Danger zone</h2>
        <Button variant="destructive" onClick={() => setDeactivateOpen(true)}>
          Deactivate account
        </Button>
      </section>

      <ChangePasswordDialog open={passwordDialogOpen} onOpenChange={setPasswordDialogOpen} />
      <DeactivateAccountDialog
        open={deactivateOpen}
        onOpenChange={setDeactivateOpen}
        onDeactivated={onLoggedOut}
      />

      <Dialog open={logoutOpen} onOpenChange={setLogoutOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log out?</DialogTitle>
            <DialogDescription>
              This signs you out of this device. Your messages and encryption keys stay in this
              device's local store, so signing back in is fast — this does not wipe the device.
            </DialogDescription>
          </DialogHeader>
          {logoutError && <p className="text-sm text-destructive">{logoutError}</p>}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setLogoutOpen(false)} disabled={loggingOut}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleLogout} disabled={loggingOut}>
              {loggingOut ? "Logging out…" : "Log out"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** UIA prompt-and-retry: mirrors `bootstrap_cross_signing`'s established convention. */
function ChangePasswordDialog({ open, onOpenChange }: ChangePasswordDialogProps) {
  const [newPassword, setNewPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  function reset() {
    setNewPassword("");
    setCurrentPassword("");
    setNeedsPassword(false);
    setError(null);
    setDone(false);
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await changePassword(newPassword, needsPassword ? currentPassword : undefined);
      setDone(true);
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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>
            {needsPassword
              ? "Re-enter your current password to confirm this change."
              : "Choose a new password for your account."}
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <p className="text-sm text-foreground">Your password has been changed.</p>
        ) : (
          <div className="space-y-3">
            {!needsPassword && (
              <div>
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
            )}
            {needsPassword && (
              <div>
                <Label htmlFor="current-password">Current password</Label>
                <Input
                  id="current-password"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}
        {!done && (
          <DialogFooter>
            <Button
              onClick={handleSubmit}
              disabled={
                submitting || (needsPassword ? currentPassword === "" : newPassword.length < 8)
              }
            >
              {submitting ? "Saving…" : needsPassword ? "Confirm" : "Continue"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface DeactivateAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeactivated: () => void;
}

const DEACTIVATE_CONFIRM_TEXT = "DEACTIVATE";

/** Double-confirm (warn step, then type-to-confirm) plus the same UIA retry as {@link ChangePasswordDialog}. */
function DeactivateAccountDialog({
  open,
  onOpenChange,
  onDeactivated,
}: DeactivateAccountDialogProps) {
  const [step, setStep] = useState<"warn" | "confirm">("warn");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setStep("warn");
    setNeedsPassword(false);
    setPassword("");
    setConfirmText("");
    setError(null);
  }

  async function handleDeactivate() {
    setSubmitting(true);
    setError(null);
    try {
      await deactivateAccount(needsPassword ? password : undefined);
      onDeactivated();
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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deactivate account</DialogTitle>
          <DialogDescription>
            This permanently deactivates your account. You will not be able to log back in, and this
            cannot be undone.
          </DialogDescription>
        </DialogHeader>

        {step === "warn" && (
          <DialogFooter>
            <Button variant="destructive" onClick={() => setStep("confirm")}>
              I understand, continue
            </Button>
          </DialogFooter>
        )}

        {step === "confirm" && (
          <div className="space-y-3">
            {!needsPassword && (
              <div>
                <Label htmlFor="deactivate-confirm">
                  Type {DEACTIVATE_CONFIRM_TEXT} to confirm
                </Label>
                <Input
                  id="deactivate-confirm"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                />
              </div>
            )}
            {needsPassword && (
              <div>
                <Label htmlFor="deactivate-password">Current password</Label>
                <Input
                  id="deactivate-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button
                variant="destructive"
                onClick={handleDeactivate}
                disabled={
                  submitting ||
                  (needsPassword ? password === "" : confirmText !== DEACTIVATE_CONFIRM_TEXT)
                }
              >
                {submitting ? "Deactivating…" : "Deactivate account"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
