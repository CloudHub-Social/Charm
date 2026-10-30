import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAttachmentUploads } from "./useAttachmentUploads";

const mocks = vi.hoisted(() => ({
  polish: false,
  web: false,
  sendAttachment: vi.fn(),
  cancelAttachmentUpload: vi.fn(),
  getMediaConfig: vi.fn(),
}));
vi.mock("@/featureFlags", () => ({ useFlag: () => mocks.polish }));
vi.mock("@/lib/platform", () => ({ isWebBuild: () => mocks.web }));
vi.mock("@/lib/matrix", () => ({
  sendAttachment: mocks.sendAttachment,
  cancelAttachmentUpload: mocks.cancelAttachmentUpload,
  getMediaConfig: mocks.getMediaConfig,
  getFileSize: vi.fn(),
  onUploadProgress: () => Promise.resolve(() => {}),
}));

const voice = { duration_ms: 1000, waveform: [0.5] };
const file = () => new File(["audio"], "Voice message.webm", { type: "audio/webm" });

describe("recorded upload ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.polish = false;
    mocks.web = false;
    mocks.cancelAttachmentUpload.mockResolvedValue(undefined);
  });

  it("aborts native recording conversion and cancels transport when its owner unmounts", async () => {
    let finish!: () => void;
    mocks.sendAttachment.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { result, unmount } = renderHook(() => useAttachmentUploads("!voice:localhost"));
    let sent!: Promise<boolean>;
    act(() => {
      sent = result.current.handleAttachFile(file(), undefined, voice);
    });
    const args = mocks.sendAttachment.mock.calls[0];
    const signal = args[5] as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
    expect(mocks.cancelAttachmentUpload).toHaveBeenCalledWith(args[2]);
    await act(async () => {
      finish();
      expect(await sent).toBe(false);
    });
  });

  it("rejects preflight from the prior account even when the room id is unchanged", async () => {
    mocks.polish = true;
    let finish!: (size: number) => void;
    mocks.getMediaConfig.mockReturnValue(
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
    );
    mocks.sendAttachment.mockClear();
    const { result, rerender } = renderHook(
      ({ account }) => useAttachmentUploads("!voice:localhost", undefined, account),
      { initialProps: { account: "@a:localhost" } },
    );
    let sent!: Promise<boolean>;
    act(() => {
      sent = result.current.handleAttachFile(file(), undefined, voice);
    });
    rerender({ account: "@b:localhost" });
    await act(async () => {
      finish(1024 * 1024);
      expect(await sent).toBe(false);
    });
    expect(mocks.sendAttachment).not.toHaveBeenCalled();
    expect(result.current.uploads).toHaveLength(0);
  });

  it("keeps an ordinary web upload in its original room across navigation and restores its failure", async () => {
    mocks.web = true;
    let fail!: (error: Error) => void;
    const failure = new Promise<Error>((resolve) => {
      fail = resolve;
    });
    mocks.sendAttachment.mockImplementation(async () => {
      const error = await failure;
      throw error;
    });
    const { result, rerender } = renderHook(
      ({ room }) => useAttachmentUploads(room, undefined, "@a:localhost"),
      { initialProps: { room: "!a:localhost" } },
    );
    let sent!: Promise<boolean>;
    act(() => {
      sent = result.current.handleAttachFile(new File(["data"], "background.png"));
    });
    const args = mocks.sendAttachment.mock.calls[0];
    const signal = args[5] as AbortSignal;
    rerender({ room: "!b:localhost" });
    expect(signal.aborted).toBe(false);
    expect(mocks.cancelAttachmentUpload).not.toHaveBeenCalled();
    expect(result.current.uploads).toHaveLength(0);
    await act(async () => {
      fail(new Error("network unavailable"));
      expect(await sent).toBe(false);
    });
    expect(result.current.uploads).toHaveLength(0);
    rerender({ room: "!a:localhost" });
    expect(result.current.uploads).toHaveLength(1);
    expect(result.current.uploads[0]).toMatchObject({
      filename: "background.png",
      failed: true,
      errorMessage: "network unavailable",
    });
    expect(mocks.sendAttachment.mock.calls[0][0]).toBe("!a:localhost");
  });

  it("still aborts ordinary web uploads across an account boundary, including returning to that account", async () => {
    mocks.web = true;
    let finish!: () => void;
    mocks.sendAttachment.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ account }) => useAttachmentUploads("!room:localhost", undefined, account),
      { initialProps: { account: "@a:localhost" } },
    );
    let sent!: Promise<boolean>;
    act(() => {
      sent = result.current.handleAttachFile(new File(["data"], "owned.png"));
    });
    const args = mocks.sendAttachment.mock.calls[0];
    rerender({ account: "@b:localhost" });
    expect((args[5] as AbortSignal).aborted).toBe(true);
    expect(mocks.cancelAttachmentUpload).toHaveBeenCalledWith(args[2]);
    rerender({ account: "@a:localhost" });
    await act(async () => {
      finish();
      expect(await sent).toBe(false);
    });
    expect(result.current.uploads).toHaveLength(0);
  });

  it("cancels voice conversion when switching rooms without moving its preview into the new room", async () => {
    let finish!: () => void;
    mocks.sendAttachment.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { result, rerender } = renderHook(({ room }) => useAttachmentUploads(room), {
      initialProps: { room: "!a:localhost" },
    });
    let sent!: Promise<boolean>;
    act(() => {
      sent = result.current.handleAttachFile(file(), undefined, voice);
    });
    const args = mocks.sendAttachment.mock.calls[0];
    rerender({ room: "!b:localhost" });
    expect((args[5] as AbortSignal).aborted).toBe(true);
    expect(mocks.cancelAttachmentUpload).toHaveBeenCalledWith(args[2]);
    await act(async () => {
      finish();
      expect(await sent).toBe(false);
    });
    expect(result.current.uploads).toHaveLength(0);
    rerender({ room: "!a:localhost" });
    expect(result.current.uploads).toHaveLength(0);
  });

  it("does not start an upload when preflight resolves after logout", async () => {
    mocks.polish = true;
    let finish!: (size: number) => void;
    const pending = new Promise<number>((resolve) => {
      finish = resolve;
    });
    mocks.getMediaConfig.mockReturnValue(pending);
    const { result, unmount } = renderHook(() => useAttachmentUploads("!voice:localhost"));
    let sent!: Promise<boolean>;
    act(() => {
      sent = result.current.handleAttachFile(file(), undefined, voice);
    });
    unmount();
    await act(async () => {
      finish(1024 * 1024);
      expect(await sent).toBe(false);
    });
    expect(mocks.sendAttachment).not.toHaveBeenCalled();
  });

  it("dismisses only the failed transaction owned by the same voice preview", async () => {
    mocks.sendAttachment.mockRejectedValue(new Error("offline"));
    const first = file();
    const second = file();
    const { result } = renderHook(() => useAttachmentUploads("!voice:localhost"));

    await act(async () => {
      expect(await result.current.handleAttachFile(first, undefined, voice)).toBe(false);
      expect(await result.current.handleAttachFile(second, undefined, voice)).toBe(false);
    });
    expect(result.current.uploads).toHaveLength(2);

    act(() => result.current.dismissFailedUploadForFile(second));
    expect(result.current.uploads).toHaveLength(1);
    act(() => result.current.dismissFailedUploadForFile(first));
    expect(result.current.uploads).toHaveLength(0);
  });
});
