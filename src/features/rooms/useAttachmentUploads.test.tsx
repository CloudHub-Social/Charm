import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAttachmentUploads } from "./useAttachmentUploads";

const mocks = vi.hoisted(() => ({
  polish: false,
  sendAttachment: vi.fn(),
  cancelAttachmentUpload: vi.fn(),
  getMediaConfig: vi.fn(),
}));
vi.mock("@/featureFlags", () => ({ useFlag: () => mocks.polish }));
vi.mock("@/lib/platform", () => ({ isWebBuild: () => false }));
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
