import { useFlag } from "@/featureFlags";
import { DND_PRESETS, useFocusMode } from "@/features/focus/useFocusMode";
import { SettingsCard, SettingTile } from "./components/SettingsCard";

function formatUntil(until: number | null): string {
  if (until == null) return "Until you turn it off";
  const date = new Date(until);
  return `Until ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/**
 * Focus mode / Do Not Disturb (Spec 30) settings entry. Behind the
 * `focus_mode` feature flag — the toggle UI is gated, but enforcement
 * (`shell::maybe_send_notification` / `push::handle_push` on the Rust side)
 * is not, so an already-set DND state (e.g. from the tray menu, which is
 * also flag-gated for its menu items — see `SettingsScreen`) keeps working
 * even if the flag were flipped off mid-session.
 *
 * Review fix: `SettingsScreen` keeps the "Focus" tab reachable as an
 * off-ramp whenever `dndActive`, even with the flag off, so this panel must
 * render (not blank out) in that same case — otherwise a user lands on a
 * visible-but-empty tab with no control to turn DND back off.
 */
export function FocusPanel() {
  const focusModeEnabled = useFlag("focus_mode");
  const { enabled, until, enable, disable } = useFocusMode();

  if (!focusModeEnabled && !enabled) return null;

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-lg font-bold text-foreground">Focus</h1>
      <SettingsCard heading="Do Not Disturb">
        <SettingTile
          title="Do Not Disturb"
          description={
            enabled ? formatUntil(until) : "Silence notifications until you turn it back off."
          }
          control={
            <div className="flex items-center gap-2">
              {enabled && (
                <span
                  data-testid="dnd-active-indicator"
                  aria-label="Do Not Disturb is active"
                  className="h-2 w-2 rounded-full bg-primary"
                />
              )}
              <input
                type="checkbox"
                aria-label="Do Not Disturb"
                checked={enabled}
                onChange={(e) => (e.target.checked ? enable() : disable())}
              />
            </div>
          }
        />
        {!enabled && (
          <SettingTile
            title="Quick durations"
            control={
              <div className="flex flex-wrap gap-2">
                {DND_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-accent"
                    onClick={() => enable(preset.ms)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            }
          />
        )}
      </SettingsCard>
    </div>
  );
}
