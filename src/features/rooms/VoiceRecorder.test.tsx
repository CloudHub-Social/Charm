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
  it("supports touch hold on a wide viewport without inferring input from width", () => {
    capture.phase = "idle";
    capture.preview = null;
    render(<VoiceRecorder mobile={false} onSend={vi.fn()} onClearFailedUpload={vi.fn()} />);
    const start = screen.getByRole("button", { name: "Record voice message" });
    fireEvent.pointerDown(start, {
      button: 0,
      isPrimary: true,
      pointerType: "touch",
      pointerId: 7,
      clientX: 120,
    });
    expect(capture.start).toHaveBeenCalledOnce();
    fireEvent.pointerUp(start, { pointerType: "touch", pointerId: 7 });
    expect(capture.stop).toHaveBeenCalledOnce();
    fireEvent.click(start, { detail: 1 });
    expect(capture.start).toHaveBeenCalledOnce();
  });

  it("releases composer ownership after an immediate capture failure", async () => {
    capture.phase = "idle";
    capture.preview = null;
    capture.start.mockResolvedValueOnce(false);
    const busy = vi.fn();
    const claim = vi.fn(() => true);
    render(
      <VoiceRecorder
        mobile={false}
        onStart={claim}
        onBusyChange={busy}
        onSend={vi.fn()}
        onClearFailedUpload={vi.fn()}
      />,
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Record voice message" })),
    );
    expect(claim).toHaveBeenCalledOnce();
    expect(busy).toHaveBeenLastCalledWith(false);
  });

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

  it("pauses a preserved preview when a dialog covers the chat", async () => {
    render(<VoiceRecorder mobile={false} onSend={vi.fn()} onClearFailedUpload={vi.fn()} />);
    const audio = screen.getByLabelText("Voice message preview") as HTMLAudioElement;
    const pause = vi.fn();
    Object.defineProperty(audio, "pause", { value: pause });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");

    await act(async () => {
      document.body.append(dialog);
      await Promise.resolve();
    });

    expect(pause).toHaveBeenCalledOnce();
    dialog.remove();
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
    capture.phase = "recording";
    pointerEvent(button, event);
    expect(capture.discard).toHaveBeenCalledOnce();
  });

  it.each(["pointercancel", "lostpointercapture"])(
    "preserves a pending microphone permission result when capture ends via %s",
    (event) => {
      const button = renderMobileRecorder();
      pointerEvent(button, "pointerdown");
      capture.phase = "requesting";
      pointerEvent(button, event);
      expect(capture.stop).toHaveBeenCalledOnce();
      expect(capture.discard).not.toHaveBeenCalled();
    },
  );

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
  it.each([false, true])("offers one panel-free composer mic (compact=%s)", (mobile) => {
    capture.phase = "idle";
    capture.preview = null;
    const view = render(
      <VoiceRecorder
        presentation="composer"
        mobile={mobile}
        onSend={vi.fn()}
        onClearFailedUpload={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", { name: "Record voice message" });
    expect(button).toHaveTextContent("");
    expect(button).toHaveClass("min-h-11", "min-w-11");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(view.container.querySelector("section")).not.toHaveClass("border");
    fireEvent.click(button, { detail: 0 });
    expect(capture.start).toHaveBeenCalledOnce();
  });

  it("suspends voice send during an external send but keeps discard available", () => {
    const onSend = vi.fn();
    render(
      <VoiceRecorder
        presentation="composer"
        mobile
        disabled
        onSend={onSend}
        onClearFailedUpload={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Send voice message" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard recording" }));
    expect(capture.discard).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("blocks touch capture while an external send owns the composer", () => {
    capture.phase = "idle";
    capture.preview = null;
    render(
      <VoiceRecorder
        presentation="composer"
        mobile
        disabled
        onSend={vi.fn()}
        onClearFailedUpload={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", { name: "Record voice message" });
    expect(button).toBeDisabled();
    pointerEvent(button, "pointerdown");
    expect(capture.start).not.toHaveBeenCalled();
  });

  it("reports preview ownership until unmount without clearing the text draft", () => {
    const onBusyChange = vi.fn();
    const onCaptureChange = vi.fn();
    const view = render(
      <VoiceRecorder
        presentation="composer"
        mobile={false}
        onBusyChange={onBusyChange}
        onCaptureChange={onCaptureChange}
        onSend={vi.fn()}
        onClearFailedUpload={vi.fn()}
      />,
    );
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    expect(onCaptureChange).toHaveBeenLastCalledWith(false);
    view.unmount();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("retries the same preview and prevents duplicate pending sends", async () => {
    let finish!: (sent: boolean) => void;
    const onSend = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      );
    const clearFailed = vi.fn();
    render(
      <VoiceRecorder
        presentation="composer"
        mobile={false}
        onSend={onSend}
        onClearFailedUpload={clearFailed}
      />,
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Send voice message" })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry voice message" }));
    fireEvent.click(screen.getByRole("button", { name: "Sending voice message…" }));
    expect(screen.getByRole("button", { name: "Discard recording" })).toBeDisabled();
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onSend.mock.calls[1]).toEqual(onSend.mock.calls[0]);
    expect(clearFailed).toHaveBeenCalledTimes(2);
    await act(async () => finish(true));
    expect(capture.discard).toHaveBeenCalledOnce();
  });

  it("cancels a permission request explicitly without sending", () => {
    capture.phase = "requesting";
    capture.preview = null;
    render(
      <VoiceRecorder
        presentation="composer"
        mobile
        onSend={vi.fn()}
        onClearFailedUpload={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard recording" }));
    expect(capture.discard).toHaveBeenCalledOnce();
  });
  it("returns focus to the composer mic after discarding a preview", () => {
    const props = { mobile: false, onSend: vi.fn(), onClearFailedUpload: vi.fn() };
    const view = render(<VoiceRecorder presentation="composer" {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard recording" }));
    capture.phase = "idle";
    capture.preview = null;
    view.rerender(<VoiceRecorder presentation="composer" {...props} />);
    expect(screen.getByRole("button", { name: "Record voice message" })).toHaveFocus();
  });
});
