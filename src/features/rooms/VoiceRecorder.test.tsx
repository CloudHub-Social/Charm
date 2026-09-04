import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceRecorder } from "./VoiceRecorder";

const capture = vi.hoisted(() => ({
  phase: "preview",
  elapsedMs: 2100,
  level: 0,
  error: null,
  preview: null as null | {
    file: File;
    url: string;
    metadata: { duration_ms: number; waveform: number[] };
  },
  start: vi.fn(),
  stop: vi.fn(),
  discard: vi.fn(),
}));
vi.mock("./useVoiceRecorder", () => ({ useVoiceRecorder: () => capture }));

describe("VoiceRecorder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capture.phase = "preview";
    capture.preview = {
      file: new File(["audio"], "Voice message.webm", { type: "audio/webm" }),
      url: "blob:local-recording",
      metadata: { duration_ms: 2100, waveform: [0.2, 0.5] },
    };
  });

  it("does not upload a preview until explicitly sent", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    render(<VoiceRecorder mobile={false} onSend={onSend} onClearFailedUpload={vi.fn()} />);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Voice message preview")).toHaveAttribute(
      "src",
      "blob:local-recording",
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Send voice message" })),
    );
    expect(onSend).toHaveBeenCalledWith(capture.preview?.file, capture.preview?.metadata);
    expect(capture.discard).toHaveBeenCalledOnce();
  });

  it("retains the preview after a failed send", async () => {
    render(
      <VoiceRecorder
        mobile={false}
        onSend={vi.fn().mockResolvedValue(false)}
        onClearFailedUpload={vi.fn()}
      />,
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Send voice message" })),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("was not sent");
    expect(capture.discard).not.toHaveBeenCalled();
  });

  it("discards without uploading", () => {
    const onSend = vi.fn();
    render(<VoiceRecorder mobile={false} onSend={onSend} onClearFailedUpload={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard recording" }));
    expect(capture.discard).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not apply a late send result after leaving the room", async () => {
    let finish!: (sent: boolean) => void;
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(
      <VoiceRecorder mobile={false} onSend={onSend} onClearFailedUpload={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    expect(screen.getByRole("button", { name: "Sending voice message…" })).toBeDisabled();
    view.unmount();
    await act(async () => finish(true));
    expect(capture.discard).not.toHaveBeenCalled();
  });

  function pointerEvent(target: HTMLElement, type: string, values: Record<string, unknown> = {}) {
    const event = new Event(type, { bubbles: true });
    Object.defineProperties(
      event,
      Object.fromEntries(
        Object.entries({
          pointerId: 1,
          pointerType: "touch",
          isPrimary: true,
          button: 0,
          clientX: 200,
          ...values,
        }).map(([key, value]) => [key, { value }]),
      ),
    );
    fireEvent(target, event);
  }

  function renderMobileRecorder() {
    capture.phase = "idle";
    capture.preview = null;
    render(<VoiceRecorder mobile onSend={vi.fn()} onClearFailedUpload={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Record voice message" });
    Object.defineProperty(button, "setPointerCapture", { value: vi.fn() });
    return button;
  }

  it("holds to record and stops on release without restarting on the synthesized click", () => {
    const button = renderMobileRecorder();
    pointerEvent(button, "pointerdown");
    expect(capture.start).toHaveBeenCalledOnce();
    pointerEvent(button, "pointerup");
    fireEvent.click(button, { detail: 1 });
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(capture.start).toHaveBeenCalledOnce();
  });

  it("discards once when sliding left and does not stop or restart on release", () => {
    const button = renderMobileRecorder();
    pointerEvent(button, "pointerdown");
    pointerEvent(button, "pointermove", { clientX: 100 });
    pointerEvent(button, "pointermove", { clientX: 90 });
    pointerEvent(button, "pointerup", { clientX: 90 });
    fireEvent.click(button, { detail: 1 });
    expect(capture.discard).toHaveBeenCalledOnce();
    expect(capture.stop).not.toHaveBeenCalled();
    expect(capture.start).toHaveBeenCalledOnce();
  });

  it.each(["pointercancel", "lostpointercapture"])("discards when capture ends via %s", (event) => {
    const button = renderMobileRecorder();
    pointerEvent(button, "pointerdown");
    pointerEvent(button, event);
    expect(capture.discard).toHaveBeenCalledOnce();
  });

  it("ignores a second finger's release", () => {
    const button = renderMobileRecorder();
    pointerEvent(button, "pointerdown");
    pointerEvent(button, "pointerdown", { pointerId: 2, isPrimary: false });
    pointerEvent(button, "pointerup", { pointerId: 2, isPrimary: false });
    expect(capture.start).toHaveBeenCalledOnce();
    expect(capture.stop).not.toHaveBeenCalled();
    pointerEvent(button, "pointerup");
    expect(capture.stop).toHaveBeenCalledOnce();
  });

  it("supports keyboard start on mobile", () => {
    const button = renderMobileRecorder();
    fireEvent.click(button, { detail: 0 });
    expect(capture.start).toHaveBeenCalledOnce();
  });

  it("supports keyboard stop on mobile", () => {
    capture.phase = "recording";
    capture.preview = null;
    render(<VoiceRecorder mobile onSend={vi.fn()} onClearFailedUpload={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }), { detail: 0 });
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(capture.start).not.toHaveBeenCalled();
  });
});
