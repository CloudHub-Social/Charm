import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeMatrix, removeAltAlias } from "./matrix";

const mocks = vi.hoisted(() => ({
  addBreadcrumb: vi.fn(),
  getClient: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@sentry/react", () => ({
  addBreadcrumb: mocks.addBreadcrumb,
  getClient: mocks.getClient,
}));

vi.mock("./matrixTransport", () => ({
  invoke: mocks.invoke,
  listen: mocks.listen,
}));

beforeEach(() => {
  mocks.addBreadcrumb.mockReset();
  mocks.invoke.mockReset();
  mocks.listen.mockReset();
  mocks.getClient.mockReset().mockReturnValue({ getOptions: () => ({ enabled: true }) });
});

describe("invokeMatrix", () => {
  it("returns the normal invoke result unchanged and records a summarized success breadcrumb", async () => {
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

    expect(mocks.invoke).toHaveBeenCalledWith(
      "send_message",
      args,
      expect.objectContaining({ skipBreadcrumb: true, onFailureBreadcrumb: expect.any(Function) }),
    );
    expect(mocks.addBreadcrumb).toHaveBeenCalledWith({
      category: "matrix.ipc",
      level: "info",
      message: "send_message succeeded",
      data: {
        command: "send_message",
        args: {
          roomId: "[redacted-string:27]",
          eventId: "[redacted-string:28]",
          access_token: "[redacted]",
        },
        result: {
          room_id: "[redacted-string:27]",
          access_token: "[redacted]",
          ok: true,
        },
        status: "success",
      },
    });
  });

  it("rethrows invoke failures unchanged and records a summarized failure breadcrumb before capture", async () => {
    const error = new Error("failed to send to !secret-room:matrix.example with password=hunter2");
    mocks.invoke.mockImplementationOnce(async (_command, _args, options) => {
      options.onFailureBreadcrumb(error, 12);
      throw error;
    });

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
        command: "send_message",
        durationMs: 12,
        args: {
          roomId: "[redacted-string:27]",
          body: "[redacted-string:27]",
        },
        error: {
          name: "Error",
          message: "[redacted-string:67]",
        },
        status: "failure",
      },
    });
  });

  it("redacts camelCase secret fields the same as their snake_case equivalents", async () => {
    const result = { ok: true };
    const args = { recoveryKey: "secret-recovery-key", newPassword: "hunter2" };
    mocks.invoke.mockResolvedValueOnce(result);

    await invokeMatrix("recover_from_key", args);

    expect(mocks.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          args: {
            recoveryKey: "[redacted]",
            newPassword: "[redacted]",
          },
        }),
      }),
    );
  });

  it("never copies free-text/path content verbatim, whatever field it's under", async () => {
    mocks.invoke.mockResolvedValueOnce({
      in_reply_to: { preview: "the secret plan is at 3pm" },
    });

    await invokeMatrix("get_timeline_page", {
      roomId: "!room:matrix.example",
      newBody: "edited text",
      caption: "a caption nobody anticipated redacting by name",
      filePath: "/Users/alice/Documents/private-notes.txt",
      // Deliberately not shaped like anything the scrubber recognizes (not a
      // `:server`-suffixed or long-enough colonless Matrix ID, not a
      // key=value secret) — this field's whole point is to prove even an
      // unrecognized shape is still summarized to a length tag, never copied
      // verbatim.
      eventId: "not-a-recognized-id-shape",
    });

    expect(mocks.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          args: {
            roomId: "[redacted-string:20]",
            newBody: "[string:11]",
            caption: "[string:46]",
            filePath: "[string:40]",
            eventId: "[string:25]",
          },
          // Nested objects beyond the top level collapse to their key list
          // rather than being summarized further, so a nested content field
          // like `preview` never gets to the point of being a string at all.
          result: { in_reply_to: { type: "object", keys: ["preview"] } },
        }),
      }),
    );
  });

  it("summarizes a colonless Matrix event ID (opaque-hash format, no :server suffix) as redacted", async () => {
    mocks.invoke.mockResolvedValueOnce({});

    await invokeMatrix("get_timeline_page", {
      eventId: "$colonless_event_id_without_a_server_suffix",
    });

    expect(mocks.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          args: { eventId: "[redacted-string:43]" },
        }),
      }),
    );
  });

  it("forwards InvokeOptions to the underlying transport invoke", async () => {
    mocks.invoke.mockResolvedValueOnce({ ok: true });

    await invokeMatrix("login", { username: "alice" }, { captureOnError: false });

    expect(mocks.invoke).toHaveBeenCalledWith(
      "login",
      { username: "alice" },
      expect.objectContaining({
        captureOnError: false,
        skipBreadcrumb: true,
        onFailureBreadcrumb: expect.any(Function),
      }),
    );
  });

  it("does not record a breadcrumb when Sentry is disabled", async () => {
    mocks.getClient.mockReturnValue({ getOptions: () => ({ enabled: false }) });
    mocks.invoke.mockResolvedValueOnce({ ok: true });

    await invokeMatrix("send_message", { roomId: "!room:matrix.example" });

    expect(mocks.addBreadcrumb).not.toHaveBeenCalled();
  });
});

describe("removeAltAlias", () => {
  it("invokes remove_alt_alias with the room id and alias", async () => {
    mocks.invoke.mockResolvedValueOnce(undefined);

    await removeAltAlias("!room:example.org", "#stale:example.org");

    expect(mocks.invoke).toHaveBeenCalledWith("remove_alt_alias", {
      roomId: "!room:example.org",
      alias: "#stale:example.org",
    });
  });
});
