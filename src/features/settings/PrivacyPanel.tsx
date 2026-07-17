import { Switch } from "@/components/ui/switch";
import { setPrivacySettings, usePrivacySettings } from "@/features/privacy/privacySettings";
import { SettingsCard, SettingTile } from "./components/SettingsCard";

const IDLE_TIMEOUT_OPTIONS = [5, 10, 15, 30, 60] as const;

/**
 * Global (not per-room) privacy toggles for read receipts, typing
 * indicators, presence, and auto-idle (Spec 40). Ported from Charm 1.0's
 * `General.tsx:477-517`; gated behind `presence_receipt_privacy_controls`
 * (see `SettingsScreen`) since it's a new, previously-missing surface.
 */
export function PrivacyPanel() {
  const settings = usePrivacySettings();

  return (
    <div className="max-w-lg space-y-6">
      <div className="space-y-1">
        <h1 className="text-lg font-bold text-foreground">Privacy</h1>
        <p className="text-sm text-muted-foreground">
          Control what you broadcast to other users. These are global — they apply to every room,
          not one at a time.
        </p>
      </div>

      <SettingsCard heading="Read receipts and typing">
        <SettingTile
          title="Send read receipts"
          description="When off, your read receipts are sent privately instead of shared with the room. Per Matrix's reciprocity rule, this also means you stop seeing other people's read receipts."
          control={
            <Switch
              checked={!settings.hideReadReceipts}
              aria-label="Send read receipts"
              onCheckedChange={(checked) => void setPrivacySettings({ hideReadReceipts: !checked })}
            />
          }
        />
        <SettingTile
          title="Send typing indicators"
          description='When off, other people never see "you are typing..." while you compose a message.'
          control={
            <Switch
              checked={!settings.hideTyping}
              aria-label="Send typing indicators"
              onCheckedChange={(checked) => void setPrivacySettings({ hideTyping: !checked })}
            />
          }
        />
      </SettingsCard>

      <SettingsCard heading="Presence">
        <SettingTile
          title="Appear offline"
          description="Always show as offline to other users, regardless of activity."
          control={
            <Switch
              checked={settings.appearOffline}
              aria-label="Appear offline"
              onCheckedChange={(checked) => void setPrivacySettings({ appearOffline: checked })}
            />
          }
        />
        <SettingTile
          title="Auto-idle when inactive"
          description="Automatically show as away after a period of inactivity, then back online when you return."
          control={
            <Switch
              checked={settings.autoIdleEnabled}
              aria-label="Auto-idle when inactive"
              disabled={settings.appearOffline}
              onCheckedChange={(checked) => void setPrivacySettings({ autoIdleEnabled: checked })}
            />
          }
        />
        {settings.autoIdleEnabled && !settings.appearOffline && (
          <SettingTile
            title="Idle timeout"
            description="How long to wait before showing away."
            control={
              <select
                aria-label="Idle timeout"
                className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
                value={settings.idleTimeoutMins}
                onChange={(e) =>
                  void setPrivacySettings({ idleTimeoutMins: Number(e.target.value) })
                }
              >
                {IDLE_TIMEOUT_OPTIONS.map((mins) => (
                  <option key={mins} value={mins}>
                    {mins} min
                  </option>
                ))}
              </select>
            }
          />
        )}
      </SettingsCard>
    </div>
  );
}
