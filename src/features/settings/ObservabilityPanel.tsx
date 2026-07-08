import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
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
  const { data } = useQuery({
    queryKey: OBSERVABILITY_QUERY_KEY,
    queryFn: readObservabilitySettings,
  });
  const [settings, setSettings] = useState(DEFAULT_OBSERVABILITY_SETTINGS);

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
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: OBSERVABILITY_QUERY_KEY });
      const previous =
        queryClient.getQueryData<ObservabilitySettings>(OBSERVABILITY_QUERY_KEY) ?? settings;
      const constrained = withAnonymousUserId(constrain(next));
      setSettings(constrained);
      queryClient.setQueryData(OBSERVABILITY_QUERY_KEY, constrained);
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context?.previous) {
        setSettings(context.previous);
        queryClient.setQueryData(OBSERVABILITY_QUERY_KEY, context.previous);
      }
    },
    onSuccess: (next) => {
      setSettings(next);
      queryClient.setQueryData(OBSERVABILITY_QUERY_KEY, next);
    },
  });

  useEffect(() => {
    if (data && !updateSettings.isPending) {
      setSettings(data);
    }
  }, [data, updateSettings.isPending]);

  const setSetting = (patch: Partial<ObservabilitySettings>) => {
    const next = withAnonymousUserId(constrain({ ...settings, ...patch }));
    setSettings(next);
    updateSettings.mutate(next);
  };
  const subDisabled = !settings.sentryEnabled;
  const canvasDisabled = subDisabled || !settings.replayEnabled;

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-lg font-bold text-foreground">Observability</h1>
      <SettingsCard heading="Sentry">
        <SettingTile
          title="Error monitoring"
          description="Send redacted crashes, errors, performance traces, release-health sessions, and breadcrumbs to Sentry. Off by default."
          control={
            <Switch
              aria-label="Enable Sentry observability"
              checked={settings.sentryEnabled}
              onCheckedChange={(checked) => setSetting({ sentryEnabled: checked })}
            />
          }
        />
        <SettingTile
          title="Session replay"
          description="Record masked DOM sessions for debugging. Text, inputs, and media stay masked or blocked."
          control={
            <Switch
              aria-label="Enable Sentry session replay"
              checked={settings.replayEnabled}
              disabled={subDisabled}
              onCheckedChange={(checked) => setSetting({ replayEnabled: checked })}
            />
          }
        />
        <SettingTile
          title="Canvas replay"
          description="Allow replay to capture canvas interactions when session replay is on."
          control={
            <Switch
              aria-label="Enable Sentry canvas replay"
              checked={settings.canvasReplayEnabled}
              disabled={canvasDisabled}
              onCheckedChange={(checked) => setSetting({ canvasReplayEnabled: checked })}
            />
          }
        />
        <SettingTile
          title="Profiling"
          description="Sample JavaScript performance profiles attached to traces."
          control={
            <Switch
              aria-label="Enable Sentry profiling"
              checked={settings.profilingEnabled}
              disabled={subDisabled}
              onCheckedChange={(checked) => setSetting({ profilingEnabled: checked })}
            />
          }
        />
        <SettingTile
          title="Structured logs"
          description="Send warning and error logs after Matrix IDs and known secret fields are redacted."
          control={
            <Switch
              aria-label="Enable Sentry structured logs"
              checked={settings.logsEnabled}
              disabled={subDisabled}
              onCheckedChange={(checked) => setSetting({ logsEnabled: checked })}
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
