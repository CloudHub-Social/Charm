import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QrLoginScreen } from "./QrLoginScreen";
import type { QrLoginProgressEvent } from "@/lib/matrix";

// This screen talks to Tauri IPC (start_qr_login, qr_login:progress events)
// the moment it mounts — mock lib/matrix entirely so the test exercises only
// the component's own rendering, not a real Tauri backend.
const startQrLogin = vi.fn().mockReturnValue(new Promise(() => {}));
const cancelQrLogin = vi.fn().mockResolvedValue(undefined);
const submitQrCheckCode = vi.fn().mockResolvedValue(undefined);
const toCanvas = vi.fn().mockResolvedValue(undefined);
let progressCallback: ((event: QrLoginProgressEvent) => void) | undefined;

vi.mock("qrcode", () => ({ default: { toCanvas: (...args: unknown[]) => toCanvas(...args) } }));

vi.mock("@/lib/matrix", () => ({
  startQrLogin: (...args: unknown[]) => startQrLogin(...args),
  submitQrCheckCode: (...args: unknown[]) => submitQrCheckCode(...args),
  cancelQrLogin: (...args: unknown[]) => cancelQrLogin(...args),
  tryRestoreSession: vi.fn(),
  onQrLoginProgress: vi.fn((callback: (event: QrLoginProgressEvent) => void) => {
    progressCallback = callback;
    return Promise.resolve(() => {});
  }),
}));

describe("QrLoginScreen", () => {
  beforeEach(() => {
    progressCallback = undefined;
    startQrLogin.mockReset().mockReturnValue(new Promise(() => {}));
    cancelQrLogin.mockReset().mockResolvedValue(undefined);
    submitQrCheckCode.mockReset().mockResolvedValue(undefined);
    toCanvas.mockReset().mockResolvedValue(undefined);
  });

  it("shows a generating-QR message before the QR code arrives", () => {
    render(
      <QrLoginScreen
        homeserverUrl="http://localhost:8010"
        onSignedIn={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("Generating QR code…")).toBeInTheDocument();
  });

  it("renders a cancel button", () => {
    render(
      <QrLoginScreen
        homeserverUrl="http://localhost:8010"
        onSignedIn={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("registers the progress listener before starting the login attempt", async () => {
    render(
      <QrLoginScreen
        homeserverUrl="http://localhost:8010"
        onSignedIn={() => {}}
        onCancel={() => {}}
      />,
    );
    await vi.waitFor(() => expect(startQrLogin).toHaveBeenCalledWith("http://localhost:8010"));
    expect(progressCallback).toBeDefined();
  });

  it("shows the check-code entry form once the other device scans", async () => {
    render(
      <QrLoginScreen
        homeserverUrl="http://localhost:8010"
        onSignedIn={() => {}}
        onCancel={() => {}}
      />,
    );
    await vi.waitFor(() => expect(progressCallback).toBeDefined());
    progressCallback?.({ state: "waiting_for_check_code" });
    expect(await screen.findByLabelText("Check code")).toBeInTheDocument();
  });

  it("shows the error message from a cancelled event", async () => {
    render(
      <QrLoginScreen
        homeserverUrl="http://localhost:8010"
        onSignedIn={() => {}}
        onCancel={() => {}}
      />,
    );
    await vi.waitFor(() => expect(progressCallback).toBeDefined());
    progressCallback?.({ state: "cancelled", reason: "the other device declined" });
    expect(await screen.findByText("the other device declined")).toBeInTheDocument();
  });

  it("renders QR, approval, and secret-sync progress states", async () => {
    render(
      <QrLoginScreen
        homeserverUrl="http://localhost:8010"
        onSignedIn={() => {}}
        onCancel={() => {}}
      />,
    );
    await vi.waitFor(() => expect(progressCallback).toBeDefined());

    act(() => progressCallback?.({ state: "qr_ready", qr_code_bytes: [1, 2, 3] }));
    expect(
      await screen.findByText("Scan this with another device you're already signed in on"),
    ).toBeInTheDocument();
    await vi.waitFor(() => expect(toCanvas).toHaveBeenCalled());

    act(() => progressCallback?.({ state: "waiting_for_approval" }));
    expect(
      await screen.findByText("Waiting for approval on your other device…"),
    ).toBeInTheDocument();

    act(() => progressCallback?.({ state: "syncing_secrets" }));
    expect(await screen.findByText("Syncing encryption keys…")).toBeInTheDocument();
  });

  it("forwards a completed session and surfaces progress errors", async () => {
    const onSignedIn = vi.fn();
    render(
      <QrLoginScreen
        homeserverUrl="http://localhost:8010"
        onSignedIn={onSignedIn}
        onCancel={() => {}}
      />,
    );
    await vi.waitFor(() => expect(progressCallback).toBeDefined());
    const session = { user_id: "@evie:localhost", device_id: "DEVICE" } as never;

    act(() => progressCallback?.({ state: "done", session }));
    expect(onSignedIn).toHaveBeenCalledWith(session);

    act(() => progressCallback?.({ state: "error", message: "rendezvous failed" }));
    expect(await screen.findByText("rendezvous failed")).toBeInTheDocument();
  });

  it("surfaces start and check-code submission failures", async () => {
    startQrLogin.mockRejectedValueOnce(new Error("MAS unavailable"));
    const { unmount } = render(
      <QrLoginScreen
        homeserverUrl="http://localhost:8010"
        onSignedIn={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(await screen.findByText("Error: MAS unavailable")).toBeInTheDocument();
    unmount();

    submitQrCheckCode.mockRejectedValueOnce(new Error("code rejected"));
    render(
      <QrLoginScreen
        homeserverUrl="http://localhost:8010"
        onSignedIn={() => {}}
        onCancel={() => {}}
      />,
    );
    await vi.waitFor(() => expect(progressCallback).toBeDefined());
    act(() => progressCallback?.({ state: "waiting_for_check_code" }));
    fireEvent.change(await screen.findByLabelText("Check code"), { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Error: code rejected")).toBeInTheDocument();
  });

  it("submits a valid check code, ignores an empty form submit, and cancels", async () => {
    const onCancel = vi.fn();
    const { container } = render(
      <QrLoginScreen
        homeserverUrl="http://localhost:8010"
        onSignedIn={() => {}}
        onCancel={onCancel}
      />,
    );
    await vi.waitFor(() => expect(progressCallback).toBeDefined());
    act(() => progressCallback?.({ state: "waiting_for_check_code" }));

    fireEvent.submit(container.querySelector("form")!);
    expect(submitQrCheckCode).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Check code"), { target: { value: "7x" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await vi.waitFor(() => expect(submitQrCheckCode).toHaveBeenCalledWith(7));
    expect(
      await screen.findByText("Waiting for approval on your other device…"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelQrLogin).toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });
});
