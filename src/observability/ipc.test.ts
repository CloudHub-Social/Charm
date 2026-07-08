import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/react";
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { invoke, ipcObservabilityTestHooks } from "./ipc";

vi.mock("@sentry/react", () => ({
  addBreadcrumb: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
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
            roomId: "![redacted]:[redacted]",
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
            roomId: "![redacted]:[redacted]",
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
            message: "failed for @[redacted]:[redacted] with password=[redacted]",
            name: "Error",
          },
          operationId: expect.stringMatching(/^ipc-/),
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
      roomId: "![redacted]:[redacted]",
    });
  });
});
