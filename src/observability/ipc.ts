import * as Sentry from "@sentry/react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { scrubSensitiveText } from "./scrubbers";

type InvokeArgs = Record<string, unknown>;

let fallbackOperationCounter = 0;

function operationId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `ipc-${globalThis.crypto.randomUUID()}`;
  }
  fallbackOperationCounter += 1;
  return `ipc-${Date.now().toString(36)}-${fallbackOperationCounter.toString(36)}`;
}

function summarizeString(value: string): string {
  const scrubbed = scrubSensitiveText(value);
  if (scrubbed !== value) return `[redacted-string:${value.length}]`;
  return `[string:${value.length}]`;
}

function summarizeValue(value: unknown, key?: string, depth = 0): unknown {
  if (
    key &&
    /^(access_token|refresh_token|password|passphrase|recovery_key|secret_storage_key|session_key)$/i.test(
      key,
    )
  ) {
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

export async function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
  const id = operationId();
  const startedAt = performance.now();
  const argsSummary = summarizeArgs(args);

  addIpcBreadcrumb("info", `IPC ${command} started`, {
    command,
    operationId: id,
    args: argsSummary,
  });

  try {
    const result = await tauriInvoke<T>(command, args);
    addIpcBreadcrumb("info", `IPC ${command} succeeded`, {
      command,
      operationId: id,
      durationMs: Math.round(performance.now() - startedAt),
      result: summarizeValue(result),
    });
    return result;
  } catch (error) {
    addIpcBreadcrumb("error", `IPC ${command} failed`, {
      command,
      operationId: id,
      durationMs: Math.round(performance.now() - startedAt),
      error: summarizeError(error),
    });
    throw error;
  }
}

export const ipcObservabilityTestHooks = {
  summarizeArgs,
  summarizeError,
  summarizeValue,
};
