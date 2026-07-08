import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { closeSentry, initializeSentry } from "@/observability/instrument";
import {
  persistObservabilitySettings,
  readObservabilitySettings,
} from "@/observability/persistence";
import {
  DEFAULT_OBSERVABILITY_SETTINGS,
  withAnonymousUserId,
  type ObservabilitySettings,
} from "@/observability/settings";
import { SettingsCard, SettingTile } from "./components/SettingsCard";

const OBSERVABILITY_QUERY_KEY = ["settings", "observability"];
const PRIVACY_URL = "https://github.com/CloudHub-Social/Charm/blob/main/PRIVACY.md";

function Checkbox({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

function constrain(settings: ObservabilitySettings): ObservabilitySettings {
  if (!settings.sentryEnabled) {
    return {
      ...settings,
      replayEnabled: false,
      canvasReplayEnabled: false,
      profilingEnabled: false,
      logsEnabled: false,
    };
  }
  if (!settings.replayEnabled) {
    return { ...settings, canvasReplayEnabled: false };
  }
  return settings;
}

export function ObservabilityPanel() {
  const queryClient = useQueryClient();
  const { data = DEFAULT_OBSERVABILITY_SETTINGS } = useQuery({
    queryKey: OBSERVABILITY_QUERY_KEY,
    queryFn: readObservabilitySettings,
  });

  const updateSettings = useMutation({
    mutationFn: async (next: ObservabilitySettings) => {
      const constrained = withAnonymousUserId(constrain(next));
      await persistObservabilitySettings(constrained);
      if (constrained.sentryEnabled) {
        initializeSentry(constrained);
      } else {
        await closeSentry();
      }
      return constrained;
    },
    onSuccess: (next) => {
      queryClient.setQueryData(OBSERVABILITY_QUERY_KEY, next);
    },
  });

  const setSetting = (patch: Partial<ObservabilitySettings>) => {
    updateSettings.mutate({ ...data, ...patch });
  };
  const disabled = updateSettings.isPending;
  const subDisabled = disabled || !data.sentryEnabled;
  const canvasDisabled = subDisabled || !data.replayEnabled;

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-lg font-bold text-foreground">Observability</h1>
      <SettingsCard heading="Sentry">
        <SettingTile
          title="Error monitoring"
          description="Send redacted crashes, errors, performance traces, release-health sessions, and breadcrumbs to Sentry. Off by default."
          control={
            <Checkbox
              label="Enable Sentry observability"
              checked={data.sentryEnabled}
              disabled={disabled}
              onChange={(checked) => setSetting({ sentryEnabled: checked })}
            />
          }
        />
        <SettingTile
          title="Session replay"
          description="Record masked DOM sessions for debugging. Text, inputs, and media stay masked or blocked."
          control={
            <Checkbox
              label="Enable Sentry session replay"
              checked={data.replayEnabled}
              disabled={subDisabled}
              onChange={(checked) => setSetting({ replayEnabled: checked })}
            />
          }
        />
        <SettingTile
          title="Canvas replay"
          description="Allow replay to capture canvas interactions when session replay is on."
          control={
            <Checkbox
              label="Enable Sentry canvas replay"
              checked={data.canvasReplayEnabled}
              disabled={canvasDisabled}
              onChange={(checked) => setSetting({ canvasReplayEnabled: checked })}
            />
          }
        />
        <SettingTile
          title="Profiling"
          description="Sample JavaScript performance profiles attached to traces."
          control={
            <Checkbox
              label="Enable Sentry profiling"
              checked={data.profilingEnabled}
              disabled={subDisabled}
              onChange={(checked) => setSetting({ profilingEnabled: checked })}
            />
          }
        />
        <SettingTile
          title="Structured logs"
          description="Send warning and error logs after Matrix IDs and known secret fields are redacted."
          control={
            <Checkbox
              label="Enable Sentry structured logs"
              checked={data.logsEnabled}
              disabled={subDisabled}
              onChange={(checked) => setSetting({ logsEnabled: checked })}
            />
          }
        />
      </SettingsCard>
      <SettingsCard heading="Privacy">
        <SettingTile
          title="Telemetry identity"
          description="Charm uses a random local identifier only after opt-in. It never sends your Matrix ID, display name, or email as the Sentry user."
        />
        <SettingTile
          title="Policy"
          control={
            <a
              href={PRIVACY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-foreground underline"
            >
              Privacy
            </a>
          }
        />
      </SettingsCard>
    </div>
  );
}
