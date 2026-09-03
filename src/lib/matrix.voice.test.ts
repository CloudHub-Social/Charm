import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendAttachment } from "./matrix";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("./matrixTransport", () => mocks);
vi.mock("./platform", () => ({ isWebBuild: () => false }));

describe("native recorded audio handoff", () => {
  const voice = { duration_ms: 1000, waveform: [0.2] };
  beforeEach(() => {
    mocks.invoke.mockReset().mockResolvedValue(undefined);
  });

  function recording() {
    const file = new File(["audio"], "Voice message.webm", { type: "audio/webm" });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
    });
    return file;
  }

  it("passes bytes and voice metadata without a filesystem path", async () => {
    await sendAttachment(
      "!room:example.org",
      recording(),
      "voice-1",
      undefined,
      false,
      undefined,
      voice,
    );
    expect(mocks.invoke).toHaveBeenCalledWith(
      "send_attachment",
      {
        roomId: "!room:example.org",
        filePath: "",
        txnId: "voice-1",
        caption: undefined,
        stripExifEnabled: false,
        voice,
        recording: { mime_type: "audio/webm", bytes: [1, 2, 3] },
      },
      expect.objectContaining({ captureOnError: expect.any(Function) }),
    );
  });

  it("rejects a File without recording metadata before invoking native code", async () => {
    await expect(sendAttachment("!room:example.org", recording(), "voice-1")).rejects.toThrow(
      "recording metadata",
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not invoke native code after cancellation during byte conversion", async () => {
    const file = recording();
    const controller = new AbortController();
    const sending = sendAttachment(
      "!room:example.org",
      file,
      "voice-1",
      undefined,
      false,
      controller.signal,
      voice,
    );
    controller.abort();
    await expect(sending).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not read an already-cancelled recording into memory", async () => {
    const file = recording();
    const readRecording = vi.spyOn(file, "arrayBuffer");
    const controller = new AbortController();
    controller.abort();
    await expect(
      sendAttachment(
        "!room:example.org",
        file,
        "voice-1",
        undefined,
        false,
        controller.signal,
        voice,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(readRecording).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("preserves the path-based native attachment contract", async () => {
    await sendAttachment("!room:example.org", "/picked/file.png", "file-1");
    expect(mocks.invoke).toHaveBeenCalledWith(
      "send_attachment",
      {
        roomId: "!room:example.org",
        filePath: "/picked/file.png",
        txnId: "file-1",
        caption: undefined,
        stripExifEnabled: true,
      },
      expect.any(Object),
    );
  });
});
