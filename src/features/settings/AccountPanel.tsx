import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useRef, useState } from "react";
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
import { isWebBuild } from "@/lib/platform";
import { SettingsCard, SettingTile } from "./components/SettingsCard";
import { BlockedUsersCard } from "./BlockedUsersCard";
import { ContactInformationCard } from "./ContactInformationCard";
import {
  useAccountDeactivateUrl,
  useProfile,
  useResolvedAvatarSrc,
  useUpdateProfile,
} from "./useProfile";
import { useUiaRetry } from "./useUiaRetry";

interface AccountPanelProps {
  onLoggedOut: () => void;
}

function openExternalUrl(url: string) {
  if (isWebBuild()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  openUrl(url);
}

export function AccountPanel({ onLoggedOut }: AccountPanelProps) {
  const { data: profile } = useProfile();
  const { updateDisplayName, updateAvatar } = useUpdateProfile();
  const avatarSrc = useResolvedAvatarSrc(profile?.avatar_url);
  const { data: deactivateUrl } = useAccountDeactivateUrl();
  const avatarInputRef = useRef<HTMLInputElement>(null);

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
    if (isWebBuild()) {
      avatarInputRef.current?.click();
      return;
    }
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

  async function handleAvatarInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      await updateAvatar.mutateAsync(file);
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
    <div className="max-w-md space-y-6">
      <h1 className="text-lg font-bold text-foreground">Account</h1>

      <SettingsCard heading="Profile">
        <SettingTile>
          <div className="flex items-center gap-4">
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={handleAvatarInputChange}
            />
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
            <p className="mt-2 text-sm text-destructive">{String(updateAvatar.error)}</p>
          )}
        </SettingTile>
        <SettingTile>
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
        </SettingTile>
        <SettingTile
          title="Matrix ID"
          control={
            <span className="font-mono text-sm text-muted-foreground">
              {profile?.user_id ?? "—"}
            </span>
          }
        />
      </SettingsCard>

      <ContactInformationCard />
      <BlockedUsersCard />

      <SettingsCard heading="Security">
        <SettingTile
          title="Password"
          description={
            profile?.uses_oauth
              ? "This account signs in through your identity provider, so its password is managed there rather than in Charm."
              : undefined
          }
          control={
            profile?.uses_oauth ? undefined : (
              <Button variant="outline" size="sm" onClick={() => setPasswordDialogOpen(true)}>
                Change password
              </Button>
            )
          }
        />
        <SettingTile
          title="Sign out"
          control={
            <Button variant="outline" size="sm" onClick={() => setLogoutOpen(true)}>
              Log out
            </Button>
          }
        />
      </SettingsCard>

      <SettingsCard heading="Danger zone">
        <SettingTile
          title="Deactivate account"
          description={
            profile?.uses_oauth && !deactivateUrl
              ? "This account signs in through your identity provider — deactivate it there instead."
              : "Permanently deactivates your account. This cannot be undone."
          }
          control={
            profile?.uses_oauth ? (
              deactivateUrl ? (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => openExternalUrl(deactivateUrl)}
                >
                  Deactivate account
                </Button>
              ) : undefined
            ) : (
              <Button variant="destructive" size="sm" onClick={() => setDeactivateOpen(true)}>
                Deactivate account
              </Button>
            )
          }
        />
      </SettingsCard>

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
  const [done, setDone] = useState(false);
  const uia = useUiaRetry((password) => changePassword(newPassword, password));
  const {
    needsPassword,
    password: currentPassword,
    setPassword: setCurrentPassword,
    error,
    submitting,
  } = uia;

  function reset() {
    setNewPassword("");
    setDone(false);
    uia.reset();
  }

  async function handleSubmit() {
    if (await uia.submit()) setDone(true);
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
            <div>
              <div className="flex items-center justify-between">
                <Label htmlFor="new-password">New password</Label>
                {needsPassword && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline hover:text-foreground"
                    onClick={() => {
                      uia.setNeedsPassword(false);
                      uia.setError(null);
                    }}
                  >
                    Edit
                  </button>
                )}
              </div>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                readOnly={needsPassword}
              />
            </div>
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
  const [confirmText, setConfirmText] = useState("");
  const uia = useUiaRetry((password) => deactivateAccount(password));
  const { needsPassword, password, setPassword, error, submitting } = uia;

  function reset() {
    setStep("warn");
    setConfirmText("");
    uia.reset();
  }

  async function handleDeactivate() {
    if (await uia.submit()) onDeactivated();
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
