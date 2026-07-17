import { SettingsCard, SettingTile } from "./components/SettingsCard";
import { usePrivacySettings, useSetPrivacySettings } from "./usePrivacySettings";

/** Idle-timeout presets offered in the dropdown, in minutes. `null` disables auto-idle. */
const IDLE_TIMEOUT_OPTIONS: { label: string; minutes: number | null }[] = [
  { label: "Never", minutes: null },
  { label: "5 minutes", minutes: 5 },
  { label: "10 minutes", minutes: 10 },
  { label: "15 minutes", minutes: 15 },
  { label: "30 minutes", minutes: 30 },
  { label: "1 hour", minutes: 60 },
];

/**
 * Spec 40 — presence and receipt privacy controls, behind the
 * `presence_privacy_controls` feature flag (gated at the call site in
 * `SettingsScreen`, matching `FocusPanel`'s pattern).
 *
 * Every toggle here writes the *entire* `PrivacySettings` object in one
 * `set_privacy_settings` call (see `usePrivacySettings`'s doc comment) so
 * two quick toggles never race each other.
 */
export function PrivacyPanel() {
  const { data: settings, isLoading } = usePrivacySettings();
  const setSettings = useSetPrivacySettings();

  if (isLoading || !settings) return null;

  const update = (patch: Partial<typeof settings>) => {
    setSettings.mutate({ ...settings, ...patch });
  };

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-lg font-bold text-foreground">Privacy</h1>
      <SettingsCard heading="Read receipts &amp; typing">
        <SettingTile
          title="Send read receipts"
          description="Per Matrix reciprocity, hiding your receipts also typically hides others' receipts from you."
          control={
            <input
              type="checkbox"
              aria-label="Send read receipts"
              checked={!settings.hide_read_receipts}
              onChange={(e) => update({ hide_read_receipts: !e.target.checked })}
            />
          }
        />
        <SettingTile
          title="Send typing indicators"
          description="Let others in a room see when you're typing a reply."
          control={
            <input
              type="checkbox"
              aria-label="Send typing indicators"
              checked={!settings.hide_typing}
              onChange={(e) => update({ hide_typing: !e.target.checked })}
            />
          }
        />
      </SettingsCard>
      <SettingsCard heading="Presence">
        <SettingTile
          title="Appear offline"
          description="Show as offline to everyone, regardless of whether you're actually using Charm."
          control={
            <input
              type="checkbox"
              aria-label="Appear offline"
              checked={settings.appear_offline}
              onChange={(e) => update({ appear_offline: e.target.checked })}
            />
          }
        />
        <SettingTile
          title="Auto-away"
          description="Automatically show as away after a period of inactivity."
          control={
            <select
              aria-label="Auto-away timeout"
              className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
              value={settings.idle_timeout_minutes ?? ""}
              onChange={(e) =>
                update({
                  idle_timeout_minutes: e.target.value === "" ? null : Number(e.target.value),
                })
              }
            >
              {IDLE_TIMEOUT_OPTIONS.map((option) => (
                <option key={option.label} value={option.minutes ?? ""}>
                  {option.label}
                </option>
              ))}
            </select>
          }
        />
      </SettingsCard>
    </div>
  );
}
