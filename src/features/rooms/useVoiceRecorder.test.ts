import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceRecorder } from "./useVoiceRecorder";
import { createElement, type PropsWithChildren } from "react";
import { ChatVisibilityContext } from "@/features/shell/chatVisibility";

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

  it("discards active capture when retained mobile chat becomes hidden", async () => {
    let visible = true;
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(ChatVisibilityContext.Provider, { value: visible }, children);
    const { result, rerender } = renderHook(() => useVoiceRecorder(), { wrapper });
    await act(async () => result.current.start());
    expect(result.current.phase).toBe("recording");
    visible = false;
    await act(async () => rerender());
    expect(stopTrack).toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
    expect(result.current.preview).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance"],
    });
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

  it("discards capture on page hide instead of recording in the background", async () => {
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => result.current.start());
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe("idle");
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects overlong capture even when interval callbacks never ran", async () => {
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => result.current.start());
    const clock = vi.spyOn(performance, "now").mockReturnValue(600_001);
    await act(async () => result.current.stop());
    clock.mockRestore();
    expect(result.current.phase).toBe("idle");
    expect(result.current.error).toContain("duration limit");
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("discards capture when a timeline-owned dialog opens", async () => {
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => result.current.start());
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    await act(async () => document.body.append(dialog));
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe("idle");
    expect(result.current.error).toContain("dialog opened");
    dialog.remove();
  });

  it("does not count delayed stop-event delivery as recorded audio", async () => {
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => result.current.start());
    const clock = vi.spyOn(performance, "now").mockReturnValue(600_000);
    await act(async () => {
      result.current.stop();
      // The queued data/stop events arrive after capture was asked to stop.
      clock.mockReturnValue(600_050);
    });
    clock.mockRestore();
    expect(result.current.phase).toBe("preview");
    expect(result.current.preview?.metadata.duration_ms).toBe(600_000);
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("revokes a stopped preview when the recorder unmounts", async () => {
    const { result, unmount } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    await act(async () => result.current.stop());
    expect(result.current.preview?.url).toBe("blob:private-preview");
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:private-preview");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores an old recorder's error and stop events after starting a new recording", async () => {
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    const oldRecorder = FakeRecorder.instances[0];
    await act(async () => result.current.discard());
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      oldRecorder.onerror?.();
      oldRecorder.ondataavailable?.({ data: new Blob(["stale audio"]) });
      oldRecorder.onstop?.();
    });
    expect(result.current.phase).toBe("recording");
    expect(result.current.error).toBeNull();
    expect(result.current.preview).toBeNull();
    expect(FakeRecorder.instances[1].state).toBe("recording");
    expect(createObjectURL).not.toHaveBeenCalled();
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

  it("activates Web Audio before awaiting microphone permission", async () => {
    let grant!: (value: MediaStream) => void;
    resumeContext.mockImplementationOnce(() => new Promise<void>(() => {}));
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
    expect(resumeContext).toHaveBeenCalledOnce();
    expect(FakeRecorder.instances).toHaveLength(0);
    await act(async () => {
      grant(stream);
      await starting;
    });
    expect(FakeRecorder.instances).toHaveLength(1);
    expect(result.current.phase).toBe("recording");
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

  it("preserves a permission denial when a mobile hold is released", async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    const denial = result.current.error;

    act(() => result.current.stop());

    expect(result.current.phase).toBe("idle");
    expect(result.current.error).toBe(denial);
  });

  it("stops at the duration limit and bounds waveform metadata", async () => {
    const { result } = renderHook(() => useVoiceRecorder());
    await act(async () => {
      await result.current.start();
    });
    await act(async () => vi.advanceTimersByTime(599_000));
    expect(result.current.phase).toBe("preview");
    expect(result.current.preview?.metadata.duration_ms).toBe(599_000);
    expect(result.current.preview?.metadata.waveform).toHaveLength(120);
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects automatic capture that materially overruns a delayed timeout", async () => {
    const { result } = renderHook(() => useVoiceRecorder());
    const clock = vi.spyOn(performance, "now");
    clock.mockReturnValue(0);
    await act(async () => {
      await result.current.start();
    });
    clock.mockReturnValue(600_050);
    await act(async () => vi.advanceTimersByTime(600_000));

    expect(result.current.phase).toBe("idle");
    expect(result.current.error).toContain("duration limit");
    expect(result.current.preview).toBeNull();
    clock.mockRestore();
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
