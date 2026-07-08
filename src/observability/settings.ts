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

  let anonymousUserId: string | null = null;
  if (typeof crypto.randomUUID === "function") {
    anonymousUserId = crypto.randomUUID();
  } else if (typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    anonymousUserId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  return {
    ...settings,
    anonymousUserId,
  };
}
