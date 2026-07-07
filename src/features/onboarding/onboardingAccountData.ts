/**
 * Global account-data event type for the first-run-onboarding completion
 * flag (Spec 12) — no version suffix in the type string itself (the payload
 * carries its own `version` field instead), matching every other
 * `social.cloudhub.charm`-namespaced identifier in this codebase.
 */
export const ONBOARDING_ACCOUNT_DATA_TYPE = "social.cloudhub.charm.onboarding";

export interface OnboardingAccountData {
  completed_at: number;
  version: 1;
}
