import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { VoiceRecorder } from "./VoiceRecorder";

const meta = {
  title: "Rooms/Composer voice accessory",
  component: VoiceRecorder,
  args: {
    presentation: "composer",
    mobile: false,
    onSend: fn(async () => false),
    onClearFailedUpload: fn(),
  },
} satisfies Meta<typeof VoiceRecorder>;
export default meta;
type Story = StoryObj<typeof meta>;

// A standalone integration fixture, not ChatShell wiring. No microphone access
// is requested by these idle-state stories. CI's axe pass covers each size.
function ComposerFixture({ compact = false }: { compact?: boolean }) {
  const [draft, setDraft] = useState("A private, unsent draft");
  const [busy, setBusy] = useState(false);
  return (
    <div
      style={{ width: compact ? 272 : 640, maxWidth: "100%" }}
      className="rounded-lg border border-border p-2"
    >
      <label className="sr-only" htmlFor="voice-fixture-draft">
        Message
      </label>
      <textarea
        id="voice-fixture-draft"
        className="w-full min-w-0 bg-transparent"
        value={draft}
        readOnly={busy}
        onChange={(event) => setDraft(event.target.value)}
      />
      <VoiceRecorder
        presentation="composer"
        mobile={compact}
        onBusyChange={setBusy}
        onSend={async () => false}
        onClearFailedUpload={() => {}}
      />
    </div>
  );
}

export const Wide: Story = {
  render: () => <ComposerFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const draft = canvas.getByRole("textbox", { name: "Message" });
    await userEvent.click(draft);
    await userEvent.tab();
    await expect(canvas.getByRole("button", { name: "Record voice message" })).toHaveFocus();
    await expect(draft).toHaveValue("A private, unsent draft");
  },
};
export const Compact: Story = { render: () => <ComposerFixture compact /> };
export const PendingTextSend: Story = { args: { disabled: true } };

// Synthetic browser capture for the active-state axe and screenshot stories.
// Restore every replaced descriptor after each story; never ask for a real mic.
function syntheticCapture() {
  const media = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const recorder = Object.getOwnPropertyDescriptor(window, "MediaRecorder");
  const audio = Object.getOwnPropertyDescriptor(window, "AudioContext");
  class SyntheticRecorder {
    static isTypeSupported() {
      return true;
    }
    state = "inactive";
    mimeType = "audio/webm";
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void;
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(["synthetic audio"]) });
        this.onstop?.();
      });
    }
  }
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
    },
  });
  Object.defineProperty(window, "MediaRecorder", { configurable: true, value: SyntheticRecorder });
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: class {
      constructor() {
        throw new Error("Synthetic fixture omits optional metering");
      }
    },
  });
  return () => {
    if (media) Object.defineProperty(navigator, "mediaDevices", media);
    else Reflect.deleteProperty(navigator, "mediaDevices");
    if (recorder) Object.defineProperty(window, "MediaRecorder", recorder);
    else Reflect.deleteProperty(window, "MediaRecorder");
    if (audio) Object.defineProperty(window, "AudioContext", audio);
    else Reflect.deleteProperty(window, "AudioContext");
  };
}

export const Recording: Story = {
  beforeEach: syntheticCapture,
  render: () => <ComposerFixture compact />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Record voice message" }));
    await expect(canvas.getByRole("button", { name: "Stop recording" })).toBeEnabled();
    await expect(canvas.getByRole("textbox")).toHaveAttribute("readonly");
  },
};
export const FailedPreview: Story = {
  beforeEach: syntheticCapture,
  render: () => <ComposerFixture compact />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Record voice message" }));
    await userEvent.click(canvas.getByRole("button", { name: "Stop recording" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Send voice message" }));
    await expect(await canvas.findByRole("button", { name: "Retry voice message" })).toBeEnabled();
    await expect(canvas.getByRole("textbox")).toHaveValue("A private, unsent draft");
  },
};

export const KeyboardDiscard: Story = {
  beforeEach: syntheticCapture,
  render: () => <ComposerFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("textbox"));
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByRole("button", { name: "Stop recording" })).toBeEnabled();
    await userEvent.tab();
    await expect(canvas.getByRole("button", { name: "Discard recording" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByRole("button", { name: "Record voice message" })).toBeEnabled();
    await expect(canvas.getByRole("textbox")).not.toHaveAttribute("readonly");
  },
};
export const TouchPreview: Story = {
  beforeEach: syntheticCapture,
  render: () => <ComposerFixture compact />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const mic = canvas.getByRole("button", { name: "Record voice message" });
    await userEvent.pointer([{ keys: "[TouchA>]", target: mic }, { keys: "[/TouchA]" }]);
    await expect(await canvas.findByRole("button", { name: "Send voice message" })).toBeEnabled();
    await expect(canvas.getByRole("textbox")).toHaveValue("A private, unsent draft");
  },
};
export const PermissionCancellation: Story = {
  beforeEach: () => {
    const restore = syntheticCapture();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => new Promise(() => {}),
      },
    });
    return restore;
  },
  render: () => <ComposerFixture compact />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Record voice message" }));
    await expect(canvas.getByText("Waiting for microphone…")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Discard recording" }));
    await expect(canvas.getByRole("button", { name: "Record voice message" })).toBeEnabled();
    await expect(canvas.getByRole("textbox")).not.toHaveAttribute("readonly");
  },
};
