import * as Sentry from "@sentry/react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { recordCount, recordDistribution } from "./metrics";
import { createIpcOperationId } from "./operationId";
import { summarizeErrorText, summarizeString, summarizeValue } from "./scrubbers";

type InvokeArgs = Record<string, unknown>;

export const IPC_OPERATION_ID_HEADER = "x-charm-operation-id";

const BEST_EFFORT_IPC_COMMANDS = new Set(["send_typing"]);

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

// Same shape as `summarizeError`, but for the captured-exception path only:
// keeps scrubbed error text (see `summarizeErrorText`) instead of collapsing
// it to a length tag, since this is what actually shows up as the Sentry
// issue title/message. Most Tauri command failures reject with a plain
// `string` (Rust commands return `Result<T, String>`), not an `Error`
// instance, so that case matters as much as the `instanceof Error` one.
function summarizeErrorForCapture(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: summarizeErrorText(error.message),
    };
  }
  if (typeof error === "string") return summarizeErrorText(error);
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

function createCapturedIpcError(command: string, error: unknown): Error {
  const summary = summarizeErrorForCapture(error);
  const capturedError = new Error(`IPC ${command} failed: ${JSON.stringify(summary)}`);
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
  /**
   * Skip this wrapper's own `tauri.ipc` breadcrumbs. Set to `true` by
   * callers (e.g. `lib/matrix.ts`'s `invokeMatrix`) that add their own,
   * more specific breadcrumb around this call — otherwise every invoke
   * would produce two overlapping breadcrumb trails per command.
   * Exception capture (`captureOnError`) is unaffected.
   */
  skipBreadcrumb?: boolean;
  /**
   * Called in place of this wrapper's own failure breadcrumb — at the same
   * point in the flow, i.e. before `captureOnError`'s exception capture —
   * so a caller supplying its own breadcrumb (e.g. `lib/matrix.ts`'s
   * `invokeMatrix`) has it appear in Sentry's breadcrumb trail *before* the
   * exception it's describing, not after. Only applies to the failure path;
   * `skipBreadcrumb` still governs the start/success breadcrumbs.
   */
  onFailureBreadcrumb?: (error: unknown, durationMs: number) => void;
}

export async function invoke<T>(
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  const captureOnError = options?.captureOnError ?? true;
  const skipBreadcrumb = options?.skipBreadcrumb ?? false;
  const id = createIpcOperationId();
  const startedAt = performance.now();
  const argsSummary = summarizeArgs(args);

  if (!skipBreadcrumb) {
    addIpcBreadcrumb("info", `IPC ${command} started`, {
      command,
      operationId: id,
      args: argsSummary,
    });
  }

  try {
    // Tauri IPC isn't `fetch`/`XHR`, so `browserTracingIntegration`'s
    // automatic outbound instrumentation never sees this call — attach the
    // same `sentry-trace`/`baggage` headers by hand so a trace started in
    // the webview continues into the Rust side (parsed back out via
    // `observability_trace.rs` on commands that opt in).
    const result = await tauriInvoke<T>(command, args, {
      headers: {
        [IPC_OPERATION_ID_HEADER]: id,
        ...Sentry.getTraceData(),
      },
    });
    const durationMs = Math.round(performance.now() - startedAt);
    if (!skipBreadcrumb) {
      addIpcBreadcrumb("info", `IPC ${command} succeeded`, {
        command,
        operationId: id,
        durationMs,
        result: summarizeValue(result),
      });
    }
    recordCount("ipc.invoke", 1, { command, outcome: "success" });
    recordDistribution("ipc.invoke.duration", durationMs, {
      unit: "millisecond",
      attributes: { command, outcome: "success" },
    });
    return result;
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    if (options?.onFailureBreadcrumb) {
      options.onFailureBreadcrumb(error, durationMs);
    } else if (!skipBreadcrumb) {
      addIpcBreadcrumb("error", `IPC ${command} failed`, {
        command,
        operationId: id,
        durationMs,
        error: summarizeError(error),
      });
    }
    recordCount("ipc.invoke", 1, { command, outcome: "error" });
    recordDistribution("ipc.invoke.duration", durationMs, {
      unit: "millisecond",
      attributes: { command, outcome: "error" },
    });
    if (shouldCaptureIpcException(command, error, captureOnError)) {
      captureIpcException(createCapturedIpcError(command, error), {
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
  summarizeErrorForCapture,
  shouldCaptureIpcException,
  summarizeArgs,
  summarizeError,
  summarizeValue,
};
