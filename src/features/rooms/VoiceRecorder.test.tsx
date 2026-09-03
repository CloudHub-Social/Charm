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
    render(<VoiceRecorder mobile={false} onSend={onSend} />);
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
    render(<VoiceRecorder mobile={false} onSend={vi.fn().mockResolvedValue(false)} />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Send voice message" })),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("was not sent");
    expect(capture.discard).not.toHaveBeenCalled();
  });

  it("discards without uploading", () => {
    const onSend = vi.fn();
    render(<VoiceRecorder mobile={false} onSend={onSend} />);
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
    const view = render(<VoiceRecorder mobile={false} onSend={onSend} />);
    fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
    expect(screen.getByRole("button", { name: "Sending voice message…" })).toBeDisabled();
    view.unmount();
    await act(async () => finish(true));
    expect(capture.discard).not.toHaveBeenCalled();
  });
});
