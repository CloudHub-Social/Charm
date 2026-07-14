import * as Sentry from "@sentry/react";

/**
 * Minimal shape of Sentry's generic Feature Flags integration instance — it
 * buffers evaluations in memory and attaches them to error/transaction events.
 * (`@sentry/core` exports a `FeatureFlagsIntegration` type, but resolving it by
 * name keeps this decoupled from the integration's exact export path.)
 */
interface FeatureFlagsIntegrationLike {
  // `getIntegrationByName<T>` constrains T to Sentry's `Integration`, which
  // requires `name`.
  name: string;
  addFeatureFlag: (name: string, value: unknown) => void;
}

/**
 * Reports one flag evaluation to Sentry so a subsequently-captured error shows
 * which flags were active. No-op unless the `FeatureFlags` integration is
 * present and the client is currently enabled. The integration remains on the
 * client after an observability opt-out, so the explicit enabled guard prevents
 * evaluations from being buffered during the disabled window.
 *
 * When the OpenFeature SDK is adopted (next increment), this is replaced by
 * `Sentry.openFeatureIntegration()` + `OpenFeatureIntegrationHook`, which
 * captures evaluations automatically; call sites (`resolveFlag` consumers) stay
 * unchanged.
 */
export function reportFlagEvaluation(name: string, value: boolean): void {
  const client = Sentry.getClient();
  if (!client?.getOptions().enabled) return;
  const integration = client?.getIntegrationByName?.<FeatureFlagsIntegrationLike>("FeatureFlags");
  integration?.addFeatureFlag(name, value);
}
