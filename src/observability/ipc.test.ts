import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { IPC_OPERATION_ID_HEADER, invoke, ipcObservabilityTestHooks } from "./ipc";

vi.mock("@sentry/react", () => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  getClient: vi.fn(),
  getTraceData: vi.fn(() => ({})),
  metrics: {
    count: vi.fn(),
    gauge: vi.fn(),
    distribution: vi.fn(),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(Sentry.getClient).mockReturnValue({
    getOptions: () => ({ enabled: true }),
  } as ReturnType<typeof Sentry.getClient>);
});

describe("IPC observability", () => {
  it("records redacted start and success breadcrumbs while returning the raw invoke result", async () => {
    const rawResult = {
      roomId: "!secret-room:example.org",
      body: "ordinary message text that must not be copied into a breadcrumb",
    };
    vi.mocked(tauriInvoke).mockResolvedValueOnce(rawResult);

    await expect(
      invoke("send_message", {
        roomId: "!secret-room:example.org",
        body: "ordinary message text that must not be copied into a breadcrumb",
        password: "secret",
        nested: {
          eventId: "$secret-event:example.org",
        },
      }),
    ).resolves.toBe(rawResult);

    expect(tauriInvoke).toHaveBeenCalledWith(
      "send_message",
      {
        roomId: "!secret-room:example.org",
        body: "ordinary message text that must not be copied into a breadcrumb",
        password: "secret",
        nested: {
          eventId: "$secret-event:example.org",
        },
      },
      {
        headers: {
          [IPC_OPERATION_ID_HEADER]: expect.stringMatching(/^ipc-/),
        },
      },
    );

    expect(Sentry.addBreadcrumb).toHaveBeenCalledTimes(2);
    expect(Sentry.addBreadcrumb).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        category: "tauri.ipc",
        level: "info",
        message: "IPC send_message started",
        data: expect.objectContaining({
          command: "send_message",
          operationId: expect.stringMatching(/^ipc-/),
          args: {
            body: "[string:63]",
            nested: {
              keys: ["eventId"],
              type: "object",
            },
            password: "[redacted]",
            roomId: "[redacted-string:24]",
          },
        }),
      }),
    );
    expect(Sentry.addBreadcrumb).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        category: "tauri.ipc",
        level: "info",
        message: "IPC send_message succeeded",
        data: expect.objectContaining({
          command: "send_message",
          durationMs: expect.any(Number),
          operationId: expect.stringMatching(/^ipc-/),
          result: {
            body: "[string:63]",
            roomId: "[redacted-string:24]",
          },
        }),
      }),
    );
  });

  it("merges Sentry.getTraceData()'s sentry-trace/baggage into the IPC headers", async () => {
    vi.mocked(Sentry.getTraceData).mockReturnValueOnce({
      "sentry-trace": "12345678901234567890123456789012-1234567890123456-1",
      baggage: "sentry-trace_id=12345678901234567890123456789012",
    });
    vi.mocked(tauriInvoke).mockResolvedValueOnce(undefined);

    await invoke("send_typing", { roomId: "!room:example.org" });

    expect(tauriInvoke).toHaveBeenCalledWith(
      "send_typing",
      { roomId: "!room:example.org" },
      {
        headers: {
          [IPC_OPERATION_ID_HEADER]: expect.stringMatching(/^ipc-/),
          "sentry-trace": "12345678901234567890123456789012-1234567890123456-1",
          baggage: "sentry-trace_id=12345678901234567890123456789012",
        },
      },
    );
  });

  it("records a redacted failure breadcrumb, captures a summarized error, and rethrows the original error", async () => {
    const error = new Error("failed for @alice:example.org with password=secret");
    vi.mocked(tauriInvoke).mockRejectedValueOnce(error);

    await expect(invoke("change_password", { password: "secret" })).rejects.toBe(error);

    expect(Sentry.addBreadcrumb).toHaveBeenCalledTimes(2);
    expect(Sentry.addBreadcrumb).toHaveBeenLastCalledWith(
      expect.objectContaining({
        category: "tauri.ipc",
        level: "error",
        message: "IPC change_password failed",
        data: expect.objectContaining({
          command: "change_password",
          error: {
            message: "[redacted-string:50]",
            name: "Error",
          },
          operationId: expect.stringMatching(/^ipc-/),
        }),
      }),
    );

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'IPC invoke failed: {"name":"Error","message":"[redacted-string:50]"}',
        name: "IpcError",
      }),
      expect.objectContaining({
        fingerprint: ["ipc-invoke-failed", "change_password"],
        contexts: expect.objectContaining({
          "tauri.ipc": expect.objectContaining({
            command: "change_password",
            operationId: expect.stringMatching(/^ipc-/),
            durationMs: expect.any(Number),
            args: {
              password: "[redacted]",
            },
          }),
        }),
        tags: expect.objectContaining({
          "ipc.command": "change_password",
        }),
      }),
    );
  });

  it("fingerprints captured exceptions by command so different commands don't collapse into one Sentry issue", async () => {
    vi.mocked(tauriInvoke).mockRejectedValueOnce(new Error("boom a"));
    await expect(invoke("command_a")).rejects.toThrow("boom a");

    vi.mocked(tauriInvoke).mockRejectedValueOnce(new Error("boom b"));
    await expect(invoke("command_b")).rejects.toThrow("boom b");

    expect(Sentry.captureException).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ fingerprint: ["ipc-invoke-failed", "command_a"] }),
    );
    expect(Sentry.captureException).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ fingerprint: ["ipc-invoke-failed", "command_b"] }),
    );
  });

  it("does not capture an expected/handled failure when the caller opts out via captureOnError: false", async () => {
    const error = new Error("wrong password");
    vi.mocked(tauriInvoke).mockRejectedValueOnce(error);

    await expect(invoke("login", { request: {} }, { captureOnError: false })).rejects.toBe(error);

    expect(Sentry.captureException).not.toHaveBeenCalled();
    // Breadcrumbs still get recorded — only the Sentry exception capture is skipped.
    expect(Sentry.addBreadcrumb).toHaveBeenLastCalledWith(
      expect.objectContaining({
        category: "tauri.ipc",
        level: "error",
        message: "IPC login failed",
      }),
    );
  });

  it("still captures a command's failure by default when no options are passed", async () => {
    const error = new Error("boom");
    vi.mocked(tauriInvoke).mockRejectedValueOnce(error);

    await expect(invoke("some_other_command")).rejects.toBe(error);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("redacts camelCase secret-ish field names, not just exact snake_case keys", () => {
    expect(
      ipcObservabilityTestHooks.summarizeArgs({
        newPassword: "super-secret-new-password",
        oldPassword: "super-secret-old-password",
        currentPassword: "super-secret-current-password",
        recoveryKey: "recovery-key-value",
        accessToken: "token-value",
        password: "plain-password",
      }),
    ).toEqual({
      newPassword: "[redacted]",
      oldPassword: "[redacted]",
      currentPassword: "[redacted]",
      recoveryKey: "[redacted]",
      accessToken: "[redacted]",
      password: "[redacted]",
    });
  });

  it("does not capture expected UIA challenges as IPC failures", async () => {
    const challenge = { kind: "UiaChallenge", session: "session-id" };
    vi.mocked(tauriInvoke).mockRejectedValueOnce(challenge);

    await expect(invoke("change_password", { password: undefined })).rejects.toBe(challenge);

    expect(Sentry.addBreadcrumb).toHaveBeenLastCalledWith(
      expect.objectContaining({
        category: "tauri.ipc",
        level: "error",
        message: "IPC change_password failed",
      }),
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("does not capture noisy best-effort typing failures", async () => {
    const error = new Error("offline");
    vi.mocked(tauriInvoke).mockRejectedValueOnce(error);

    await expect(invoke("send_typing", { roomId: "!room:example.org", typing: true })).rejects.toBe(
      error,
    );

    expect(Sentry.addBreadcrumb).toHaveBeenLastCalledWith(
      expect.objectContaining({
        category: "tauri.ipc",
        level: "error",
        message: "IPC send_typing failed",
      }),
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("does not send a Sentry event while the current Sentry client is disabled, even on failure", async () => {
    vi.mocked(Sentry.getClient).mockReturnValue({
      getOptions: () => ({ enabled: false }),
    } as ReturnType<typeof Sentry.getClient>);
    const error = new Error("boom");
    vi.mocked(tauriInvoke).mockRejectedValueOnce(error);

    await expect(invoke("logout")).rejects.toBe(error);

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("falls back to a local operation id when crypto randomUUID is unavailable", async () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: undefined,
    });
    vi.mocked(tauriInvoke).mockResolvedValueOnce(null);

    try {
      await invoke("logout");
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        configurable: true,
        value: originalCrypto,
      });
    }

    expect(Sentry.addBreadcrumb).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          operationId: expect.stringMatching(/^ipc-[a-z0-9]+-[a-z0-9]+$/),
        }),
      }),
    );
  });

  it("summarizes unsensitive strings instead of copying them into breadcrumb data", () => {
    expect(
      ipcObservabilityTestHooks.summarizeArgs({
        body: "hello from a private conversation",
        roomId: "!room:example.org",
      }),
    ).toEqual({
      body: "[string:33]",
      roomId: "[redacted-string:17]",
    });
  });

  it("builds captured IPC errors from summarized data only", () => {
    const error = new Error("https://homeserver.example login failed");

    expect(ipcObservabilityTestHooks.createCapturedIpcError(error)).toMatchObject({
      message: 'IPC invoke failed: {"name":"Error","message":"[string:39]"}',
      name: "IpcError",
    });
  });

  it("does not record breadcrumbs while the current Sentry client is disabled", async () => {
    vi.mocked(Sentry.getClient).mockReturnValue({
      getOptions: () => ({ enabled: false }),
    } as ReturnType<typeof Sentry.getClient>);
    vi.mocked(tauriInvoke).mockResolvedValueOnce(null);

    await invoke("logout");

    expect(Sentry.addBreadcrumb).not.toHaveBeenCalled();
  });

  it("skips this wrapper's own breadcrumbs when skipBreadcrumb is set, without affecting exception capture", async () => {
    vi.mocked(tauriInvoke).mockResolvedValueOnce(null);

    await invoke("send_message", { roomId: "!room:example.org" }, { skipBreadcrumb: true });

    expect(Sentry.addBreadcrumb).not.toHaveBeenCalled();

    const error = new Error("boom");
    vi.mocked(tauriInvoke).mockRejectedValueOnce(error);

    await expect(
      invoke("send_message", { roomId: "!room:example.org" }, { skipBreadcrumb: true }),
    ).rejects.toThrow();

    expect(Sentry.addBreadcrumb).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it("calls onFailureBreadcrumb before captureOnError's exception capture, instead of its own breadcrumb", async () => {
    const error = new Error("boom");
    vi.mocked(tauriInvoke).mockRejectedValueOnce(error);
    const callOrder: string[] = [];
    vi.mocked(Sentry.captureException).mockImplementationOnce(() => {
      callOrder.push("captureException");
      return "event-id";
    });
    const onFailureBreadcrumb = vi.fn(() => {
      callOrder.push("onFailureBreadcrumb");
    });

    await expect(
      invoke(
        "send_message",
        { roomId: "!room:example.org" },
        { skipBreadcrumb: true, onFailureBreadcrumb },
      ),
    ).rejects.toThrow();

    expect(onFailureBreadcrumb).toHaveBeenCalledWith(error, expect.any(Number));
    expect(Sentry.addBreadcrumb).not.toHaveBeenCalled();
    expect(callOrder).toEqual(["onFailureBreadcrumb", "captureException"]);
  });
});
