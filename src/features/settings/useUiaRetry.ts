import { useState } from "react";
import type { UiaCommandError } from "@bindings/UiaCommandError";

export function isUiaCommandError(err: unknown): err is UiaCommandError {
  if (typeof err !== "object" || err === null || !("kind" in err)) return false;
  if (err.kind === "UiaChallenge") return true;
  return err.kind === "Other" && "message" in err && typeof err.message === "string";
}

export function uiaErrorMessage(err: unknown): string {
  if (isUiaCommandError(err)) {
    return err.kind === "Other" ? err.message : "Authentication failed.";
  }
  return String(err);
}

export interface UseUiaRetryResult {
  needsPassword: boolean;
  setNeedsPassword: (value: boolean) => void;
  password: string;
  setPassword: (value: string) => void;
  error: string | null;
  setError: (value: string | null) => void;
  submitting: boolean;
  /** Runs `action`, returning whether it succeeded. On failure it either flips into the password prompt or sets `error`, so callers only need to branch on the return value. */
  submit: () => Promise<boolean>;
  reset: () => void;
}

/**
 * Drives the "call without a password, prompt for one if the backend wants
 * UIA, retry with it" flow shared by `change_password`, `deactivate_account`,
 * `delete_device`, and `bootstrap_cross_signing`. Branches on the structured
 * `UiaCommandError.kind` the backend returns — not "did the first call fail
 * at all" — so a real error (network failure, 500, etc.) surfaces as an
 * error instead of being misread as a password prompt.
 */
export function useUiaRetry(action: (password?: string) => Promise<void>): UseUiaRetryResult {
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(): Promise<boolean> {
    setSubmitting(true);
    setError(null);
    try {
      await action(needsPassword ? password : undefined);
      return true;
    } catch (err) {
      if (isUiaCommandError(err) && err.kind === "UiaChallenge") {
        setNeedsPassword(true);
      } else {
        setError(uiaErrorMessage(err));
      }
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setNeedsPassword(false);
    setPassword("");
    setError(null);
  }

  return {
    needsPassword,
    setNeedsPassword,
    password,
    setPassword,
    error,
    setError,
    submitting,
    submit,
    reset,
  };
}
