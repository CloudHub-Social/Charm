import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeMatrix } from "./matrix";

const mocks = vi.hoisted(() => ({
  addBreadcrumb: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@sentry/react", () => ({
  addBreadcrumb: mocks.addBreadcrumb,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

beforeEach(() => {
  mocks.addBreadcrumb.mockReset();
  mocks.invoke.mockReset();
});

describe("invokeMatrix", () => {
  it("returns the normal invoke result unchanged and records a redacted success breadcrumb", async () => {
    const result = {
      room_id: "!secret-room:matrix.example",
      access_token: "secret-token",
      ok: true,
    };
    const args = {
      roomId: "!secret-room:matrix.example",
      eventId: "$secret-event:matrix.example",
      access_token: "secret-token",
    };
    mocks.invoke.mockResolvedValueOnce(result);

    await expect(invokeMatrix("send_message", args)).resolves.toBe(result);

    expect(mocks.invoke).toHaveBeenCalledWith("send_message", args);
    expect(mocks.addBreadcrumb).toHaveBeenCalledWith({
      category: "matrix.ipc",
      level: "info",
      message: "send_message succeeded",
      data: {
        command: "send_message",
        args: {
          roomId: "![redacted]:[redacted]",
          eventId: "$[redacted]:[redacted]",
          access_token: "[redacted]",
        },
        result: {
          room_id: "![redacted]:[redacted]",
          access_token: "[redacted]",
          ok: true,
        },
        status: "success",
      },
    });
  });

  it("rethrows invoke failures unchanged and records a redacted failure breadcrumb", async () => {
    const error = new Error("failed to send to !secret-room:matrix.example with password=hunter2");
    mocks.invoke.mockRejectedValueOnce(error);

    await expect(
      invokeMatrix("send_message", {
        roomId: "!secret-room:matrix.example",
        body: "hello @alice:matrix.example",
      }),
    ).rejects.toBe(error);

    expect(mocks.addBreadcrumb).toHaveBeenCalledWith({
      category: "matrix.ipc",
      level: "error",
      message: "send_message failed",
      data: {
        args: {
          body: "hello @[redacted]:[redacted]",
          roomId: "![redacted]:[redacted]",
        },
        command: "send_message",
        error: "failed to send to ![redacted]:[redacted] with password=[redacted]",
        status: "failure",
      },
    });
  });
});
