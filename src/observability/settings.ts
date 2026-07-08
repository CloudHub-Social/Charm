export interface ObservabilitySettings {
  sentryEnabled: boolean;
  replayEnabled: boolean;
  canvasReplayEnabled: boolean;
  profilingEnabled: boolean;
  logsEnabled: boolean;
  anonymousUserId: string | null;
}

export const DEFAULT_OBSERVABILITY_SETTINGS: ObservabilitySettings = {
  sentryEnabled: false,
  replayEnabled: false,
  canvasReplayEnabled: false,
  profilingEnabled: false,
  logsEnabled: false,
  anonymousUserId: null,
};

export function normalizeObservabilitySettings(value: unknown): ObservabilitySettings {
  if (typeof value !== "object" || value === null) return DEFAULT_OBSERVABILITY_SETTINGS;
  const record = value as Partial<Record<keyof ObservabilitySettings, unknown>>;
  const sentryEnabled = record.sentryEnabled === true;
  const replayEnabled = sentryEnabled && record.replayEnabled === true;

  return {
    sentryEnabled,
    replayEnabled,
    canvasReplayEnabled: replayEnabled && record.canvasReplayEnabled === true,
    profilingEnabled: sentryEnabled && record.profilingEnabled === true,
    logsEnabled: sentryEnabled && record.logsEnabled === true,
    anonymousUserId:
      typeof record.anonymousUserId === "string" && record.anonymousUserId.length > 0
        ? record.anonymousUserId
        : null,
  };
}

export function withAnonymousUserId(settings: ObservabilitySettings): ObservabilitySettings {
  if (!settings.sentryEnabled || settings.anonymousUserId) return settings;
  return {
    ...settings,
    anonymousUserId:
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  };
}
