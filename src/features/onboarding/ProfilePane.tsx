import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useOwnProfile } from "@/features/profile/useOwnProfile";
import { setDisplayName } from "@/lib/matrix";

interface ProfilePaneProps {
  onNext: () => void;
  onSkip: () => void;
}

/**
 * Thin entry point onto Spec 01's `get_own_profile`/`set_display_name` — no
 * avatar upload here (that's Settings' `AccountPanel`, a non-goal for
 * onboarding per Spec 12).
 *
 * Save is disabled while the profile is still loading: `displayName` reads
 * `""` until `profile` resolves, so a click landing before then would call
 * `setDisplayName(null)` and clear an existing name rather than genuinely
 * saving a blank one.
 */
export function ProfilePane({ onNext, onSkip }: ProfilePaneProps) {
  const queryClient = useQueryClient();
  const { data: profile, isPending: profilePending } = useOwnProfile();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const displayName = draft ?? profile?.display_name ?? "";

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await setDisplayName(displayName.trim() === "" ? null : displayName.trim());
      queryClient.invalidateQueries({ queryKey: ["own-profile"] });
      onNext();
    } catch (err) {
      // Acceptance criterion 7: a failed save must never block completing
      // onboarding — the user can still finish via "Not now" below.
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
      <h1 className="text-xl font-bold text-foreground">Say hello</h1>
      <p className="text-sm text-muted-foreground">
        Add a display name so people recognize you. Change it anytime in Settings.
      </p>
      <Avatar size="lg">
        <AvatarFallback>
          {(displayName || profile?.user_id || "?").slice(0, 1).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="w-full max-w-xs text-left">
        <Label htmlFor="onboarding-display-name">Display name</Label>
        <Input
          id="onboarding-display-name"
          value={displayName}
          onChange={(e) => setDraft(e.target.value)}
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button className="h-11 w-full" onClick={handleSave} disabled={saving || profilePending}>
        {saving ? "Saving…" : "Save and finish"}
      </Button>
      <Button variant="ghost" className="h-11 w-full" onClick={onSkip}>
        Not now
      </Button>
    </div>
  );
}
