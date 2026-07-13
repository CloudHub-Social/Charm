import * as Sentry from "@sentry/react";

/**
 * Thin, gated wrappers around `Sentry.metrics.*`. Every call is a no-op
 * unless the Sentry client is initialized and enabled — mirrors the same
 * `client?.getOptions().enabled` guard `ipc.ts`'s breadcrumb/exception
 * helpers use, so metrics respect the user's observability settings
 * (Settings → Privacy) exactly like every other Sentry signal in the app.
 */

export type MetricAttributes = Record<string, string | number | boolean>;

function metricsEnabled(): boolean {
  const client = Sentry.getClient();
  return Boolean(client?.getOptions().enabled);
}

export function recordCount(name: string, value = 1, attributes?: MetricAttributes): void {
  if (!metricsEnabled()) return;
  Sentry.metrics.count(name, value, attributes ? { attributes } : undefined);
}

export function recordGauge(
  name: string,
  value: number,
  options?: { unit?: string; attributes?: MetricAttributes },
): void {
  if (!metricsEnabled()) return;
  Sentry.metrics.gauge(name, value, options);
}

export function recordDistribution(
  name: string,
  value: number,
  options?: { unit?: string; attributes?: MetricAttributes },
): void {
  if (!metricsEnabled()) return;
  Sentry.metrics.distribution(name, value, options);
}
