import * as Sentry from "@sentry/react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { recordCount, recordDistribution } from "./metrics";
import { createIpcOperationId } from "./operationId";
import { scrubSensitiveText } from "./scrubbers";

type InvokeArgs = Record<string, unknown>;

export const IPC_OPERATION_ID_HEADER = "x-charm-operation-id";

const BEST_EFFORT_IPC_COMMANDS = new Set(["send_typing"]);

function summarizeString(value: string): string {
  const scrubbed = scrubSensitiveText(value);
  if (scrubbed !== value) return `[redacted-string:${value.length}]`;
  return `[string:${value.length}]`;
}

// Matches both snake_case and camelCase secret-ish field names (e.g.
// `password`, `newPassword`, `oldPassword`, `recovery_key`, `recoveryKey`,
// `access_token`, `accessToken`) so a Rust command parameter name doesn't
// have to line up exactly with one of these literals to get redacted — only
// the meaningful word boundary does.
const SENSITIVE_KEY_PATTERN =
  /(?:access[_-]?token|refresh[_-]?token|password|passphrase|recovery[_-]?key|secret[_-]?storage[_-]?key|session[_-]?key|secret)$/i;

function summarizeValue(value: unknown, key?: string, depth = 0): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) {
    return "[redacted]";
  }
  if (typeof value === "string") return summarizeString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "undefined") return "[undefined]";
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (typeof value !== "object") return `[${typeof value}]`;
  // eslint-disable-next-line unicorn/no-array-sort -- `toSorted()` is not available in supported older WebViews.
  if (depth >= 1) return { type: "object", keys: Object.keys(value).sort() };

  const output: Record<string, unknown> = {};
  for (const [fieldKey, fieldValue] of Object.entries(value as Record<string, unknown>)) {
    output[fieldKey] = summarizeValue(fieldValue, fieldKey, depth + 1);
  }
  return output;
}

function summarizeArgs(args?: InvokeArgs): Record<string, unknown> | undefined {
  if (!args) return undefined;
  return summarizeValue(args) as Record<string, unknown>;
}

function summarizeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: summarizeString(error.message),
    };
  }
  return summarizeValue(error);
}

function isUiaChallenge(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { kind?: unknown }).kind === "UiaChallenge"
  );
}

function shouldCaptureIpcException(
  command: string,
  error: unknown,
  captureOnError = true,
): boolean {
  if (!captureOnError) return false;
  if (isUiaChallenge(error)) return false;
  return !BEST_EFFORT_IPC_COMMANDS.has(command);
}

function createCapturedIpcError(error: unknown): Error {
  const summary = summarizeError(error);
  const capturedError = new Error(`IPC invoke failed: ${JSON.stringify(summary)}`);
  capturedError.name = error instanceof Error ? `Ipc${error.name}` : "IpcError";
  return capturedError;
}

function addIpcBreadcrumb(
  level: "info" | "error",
  message: string,
  data: Record<string, unknown>,
): void {
  const client = Sentry.getClient();
  if (!client?.getOptions().enabled) return;

  Sentry.addBreadcrumb({
    category: "tauri.ipc",
    level,
    message,
    data,
  });
}

function captureIpcException(
  capturedError: Error,
  context: {
    command: string;
    operationId: string;
    durationMs: number;
    args?: Record<string, unknown>;
  },
): void {
  const client = Sentry.getClient();
  if (!client?.getOptions().enabled) return;

  Sentry.captureException(capturedError, {
    // Sentry groups issues primarily by fingerprint (falling back to
    // stack/message when absent), not by tags. Every IPC failure builds its
    // `Error` from the same helper with a generic message like
    // `"[string:17]"`, so without an explicit fingerprint, failures from
    // different commands can collapse into one Sentry issue. Including the
    // command name here keeps each command's failures grouped separately.
    fingerprint: ["ipc-invoke-failed", context.command],
    contexts: {
      "tauri.ipc": {
        command: context.command,
        operationId: context.operationId,
        durationMs: context.durationMs,
        args: context.args,
      },
    },
    tags: {
      "ipc.command": context.command,
    },
  });
}

export interface InvokeOptions {
  /**
   * Whether an IPC failure should be captured as a Sentry exception.
   * Defaults to `true`. Set to `false` for commands whose failures are a
   * normal, expected part of the UX (e.g. a login attempt with the wrong
   * password, or homeserver discovery failing while the user is still
   * typing) rather than a bug — capturing those would just add noise to the
   * error stream. UIA challenges and best-effort commands are still
   * filtered out regardless of this flag.
   */
  captureOnError?: boolean;
}

export async function invoke<T>(
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  const captureOnError = options?.captureOnError ?? true;
  const id = createIpcOperationId();
  const startedAt = performance.now();
  const argsSummary = summarizeArgs(args);

  addIpcBreadcrumb("info", `IPC ${command} started`, {
    command,
    operationId: id,
    args: argsSummary,
  });

  try {
    const result = await tauriInvoke<T>(command, args, {
      headers: {
        [IPC_OPERATION_ID_HEADER]: id,
      },
    });
    const durationMs = Math.round(performance.now() - startedAt);
    addIpcBreadcrumb("info", `IPC ${command} succeeded`, {
      command,
      operationId: id,
      durationMs,
      result: summarizeValue(result),
    });
    recordCount("ipc.invoke", 1, { command, outcome: "success" });
    recordDistribution("ipc.invoke.duration", durationMs, {
      unit: "millisecond",
      attributes: { command, outcome: "success" },
    });
    return result;
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    addIpcBreadcrumb("error", `IPC ${command} failed`, {
      command,
      operationId: id,
      durationMs,
      error: summarizeError(error),
    });
    recordCount("ipc.invoke", 1, { command, outcome: "error" });
    recordDistribution("ipc.invoke.duration", durationMs, {
      unit: "millisecond",
      attributes: { command, outcome: "error" },
    });
    if (shouldCaptureIpcException(command, error, captureOnError)) {
      captureIpcException(createCapturedIpcError(error), {
        command,
        operationId: id,
        durationMs,
        args: argsSummary,
      });
    }
    throw error;
  }
}

export const ipcObservabilityTestHooks = {
  createCapturedIpcError,
  shouldCaptureIpcException,
  summarizeArgs,
  summarizeError,
  summarizeValue,
};
