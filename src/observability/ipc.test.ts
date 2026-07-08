import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { invoke, ipcObservabilityTestHooks } from "./ipc";

vi.mock("@sentry/react", () => ({
  addBreadcrumb: vi.fn(),
  getClient: vi.fn(),
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

    expect(tauriInvoke).toHaveBeenCalledWith("send_message", {
      roomId: "!secret-room:example.org",
      body: "ordinary message text that must not be copied into a breadcrumb",
      password: "secret",
      nested: {
        eventId: "$secret-event:example.org",
      },
    });

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

  it("records a redacted failure breadcrumb and rethrows the original error", async () => {
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

  it("does not record breadcrumbs while the current Sentry client is disabled", async () => {
    vi.mocked(Sentry.getClient).mockReturnValue({
      getOptions: () => ({ enabled: false }),
    } as ReturnType<typeof Sentry.getClient>);
    vi.mocked(tauriInvoke).mockResolvedValueOnce(null);

    await invoke("logout");

    expect(Sentry.addBreadcrumb).not.toHaveBeenCalled();
  });
});
