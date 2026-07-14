import type { FeatureFlagKey } from "@bindings/FeatureFlagKey";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  clearFeatureFlagOverride,
  FEATURE_FLAG_CATALOG,
  FEATURE_FLAG_KEYS,
  setFeatureFlagOverride,
  useFeatureFlagOverrides,
} from "@/featureFlags";
import { SettingsCard, SettingTile } from "./components/SettingsCard";

/** `rich_message_rendering` -> `Rich message rendering`. */
function humanizeKey(key: string): string {
  const spaced = key.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Labs: per-install toggles for experimental feature flags (Spec 34/35). Writes
 * the *local override* layer — these win over the flag's default (and, once the
 * remote rollout layer ships, over remote state too), persist per install, and
 * are not synced across devices. Hidden in the production environment (see
 * `SettingsScreen`), so this is a dev/preview/internal affordance.
 */
export function LabsPanel() {
  const overrides = useFeatureFlagOverrides();

  return (
    <div className="max-w-lg space-y-6">
      <div className="space-y-1">
        <h1 className="text-lg font-bold text-foreground">Labs</h1>
        <p className="text-sm text-muted-foreground">
          Experimental features, toggled per install. Overrides win over defaults and persist on
          this device only — they aren't synced. Flipping one takes effect immediately.
        </p>
      </div>

      <SettingsCard heading="Feature flags">
        {FEATURE_FLAG_KEYS.map((key: FeatureFlagKey) => {
          const definition = FEATURE_FLAG_CATALOG[key];
          const override = overrides[key];
          const overridden = typeof override === "boolean";
          const enabled = overridden ? override : definition.default;
          return (
            <SettingTile
              key={key}
              title={humanizeKey(key)}
              description={
                <>
                  {definition.description}
                  {overridden ? (
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      Overridden (default {definition.default ? "on" : "off"}).{" "}
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0 text-xs"
                        onClick={() => void clearFeatureFlagOverride(key)}
                      >
                        Reset to default
                      </Button>
                    </span>
                  ) : null}
                </>
              }
              control={
                <Switch
                  checked={enabled}
                  aria-label={`Toggle ${humanizeKey(key)}`}
                  onCheckedChange={(checked) => void setFeatureFlagOverride(key, checked)}
                />
              }
            />
          );
        })}
      </SettingsCard>
    </div>
  );
}
