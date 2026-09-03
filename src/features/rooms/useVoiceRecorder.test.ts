import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceRecorder } from "./useVoiceRecorder";

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = () => true;
  state = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_stream: MediaStream, options: { mimeType: string }) {
    this.mimeType = options.mimeType;
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(["recorded audio"]) });
      this.onstop?.();
    });
  }
}

describe("useVoiceRecorder", () => {
  const stopTrack = vi.fn();
  const closeContext = vi.fn().mockResolvedValue(undefined);
  const resumeContext = vi.fn();
  const getUserMedia = vi.fn();
  const createObjectURL = vi.fn(() => "blob:private-preview");
  const revokeObjectURL = vi.fn();
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    FakeRecorder.instances = [];
    getUserMedia.mockResolvedValue(stream);
    resumeContext.mockResolvedValue(undefined);
    vi.stubGlobal(
      "navigator",
      Object.create(navigator, {
        mediaDevices: { value: { getUserMedia } },
      }),
    );
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    vi.stubGlobal(
      "AudioContext",
      class {
        resume = resumeContext;
        close = closeContext;
        createAnalyser() {
          return {
            fftSize: 256,
            getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.5),
          };
        }
        createMediaStreamSource() {
          return { connect: vi.fn() };
        }
      },
    );
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = revokeObjectURL;
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("stops capture before exposing a local preview and revokes it on discard", async () => {
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(result.current.phase).toBe("recording");
    act(() => vi.advanceTimersByTime(1200));
    await act(async () => result.current.stop());
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(closeContext).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(result.current.phase).toBe("preview");
    expect(result.current.preview?.metadata.duration_ms).toBe(1200);
    expect(result.current.preview?.metadata.waveform).toEqual(Array(12).fill(0.5));
    expect(result.current.preview?.file.type).toBe("audio/webm;codecs=opus");
    act(() => result.current.discard());
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:private-preview");
    expect(result.current.preview).toBeNull();
  });

  it("discards active capture without creating a preview from late recorder events", async () => {
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    await act(async () => result.current.discard());
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe("idle");
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases a stream granted after the user discards the permission request", async () => {
    let grant!: (value: MediaStream) => void;
    getUserMedia.mockImplementationOnce(
      () =>
        new Promise<MediaStream>((resolve) => {
          grant = resolve;
        }),
    );
    const { result } = renderHook(() => useVoiceRecorder());
    let starting!: Promise<void>;
    act(() => {
      starting = result.current.start();
    });
    expect(result.current.phase).toBe("requesting");
    act(() => result.current.stop());
    await act(async () => {
      grant(stream);
      await starting;
    });
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(result.current.phase).toBe("idle");
  });

  it("releases a stream granted after unmount", async () => {
    let grant!: (value: MediaStream) => void;
    getUserMedia.mockImplementationOnce(
      () =>
        new Promise<MediaStream>((resolve) => {
          grant = resolve;
        }),
    );
    const { result, unmount } = renderHook(() => useVoiceRecorder());
    let starting!: Promise<void>;
    act(() => {
      starting = result.current.start();
    });
    unmount();
    await act(async () => {
      grant(stream);
      await starting;
    });
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(FakeRecorder.instances).toHaveLength(0);
  });

  it("releases active capture on unmount", async () => {
    const { result, unmount } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    await act(async () => unmount());
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(closeContext).toHaveBeenCalledOnce();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases the microphone immediately while audio resume is still pending", async () => {
    let resume!: () => void;
    resumeContext.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    );
    const { result, unmount } = renderHook(() => useVoiceRecorder());
    let starting!: Promise<void>;
    await act(async () => {
      starting = result.current.start();
    });
    expect(resumeContext).toHaveBeenCalledOnce();
    expect(FakeRecorder.instances).toHaveLength(0);
    unmount();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(closeContext).toHaveBeenCalledOnce();
    await act(async () => {
      resume();
      await starting;
    });
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(FakeRecorder.instances).toHaveLength(0);
  });

  it("shows actionable permission denial without opening capture", async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.error).toContain("Microphone access was denied");
    expect(result.current.phase).toBe("idle");
    expect(FakeRecorder.instances).toHaveLength(0);
  });

  it("stops at the duration limit and bounds waveform metadata", async () => {
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    await act(async () => vi.advanceTimersByTime(600_000));
    expect(result.current.phase).toBe("preview");
    expect(result.current.preview?.metadata.duration_ms).toBe(600_000);
    expect(result.current.preview?.metadata.waveform).toHaveLength(120);
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards an oversized chunk without creating a preview", async () => {
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      FakeRecorder.instances[0].ondataavailable?.({
        data: { size: 32 * 1024 * 1024 + 1 } as Blob,
      });
    });
    expect(result.current.phase).toBe("idle");
    expect(result.current.error).toContain("size limit");
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
