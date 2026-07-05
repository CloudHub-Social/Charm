import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QrLoginScreen } from "./QrLoginScreen";
import type { QrLoginProgressEvent } from "@/lib/matrix";

// This screen talks to Tauri IPC (start_qr_login, qr_login:progress events)
// the moment it mounts — mock lib/matrix entirely so the test exercises only
// the component's own rendering, not a real Tauri backend.
const startQrLogin = vi.fn().mockReturnValue(new Promise(() => {}));
const cancelQrLogin = vi.fn().mockResolvedValue(undefined);
let progressCallback: ((event: QrLoginProgressEvent) => void) | undefined;

vi.mock("@/lib/matrix", () => ({
  startQrLogin: (...args: unknown[]) => startQrLogin(...args),
  submitQrCheckCode: vi.fn(),
  cancelQrLogin: (...args: unknown[]) => cancelQrLogin(...args),
  tryRestoreSession: vi.fn(),
  onQrLoginProgress: vi.fn((callback: (event: QrLoginProgressEvent) => void) => {
    progressCallback = callback;
    return Promise.resolve(() => {});
  }),
}));

describe("QrLoginScreen", () => {
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
});
