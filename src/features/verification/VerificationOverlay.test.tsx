import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, Provider as JotaiProvider } from "jotai";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsOpenAtom } from "@/features/settings/settingsAtoms";
import { VerificationOverlay } from "./VerificationOverlay";
import type { SasUpdateEvent, VerificationRequestSummary } from "@/lib/matrix";

let verificationRequestCallback: ((request: VerificationRequestSummary) => void) | undefined;
let sasUpdateCallbacks: Map<string, (update: SasUpdateEvent) => void>;

const acceptVerificationRequest = vi.fn().mockResolvedValue(undefined);
const cancelVerification = vi.fn().mockResolvedValue(undefined);
const confirmSasVerification = vi.fn().mockResolvedValue(undefined);
const startSasVerification = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/matrix", () => ({
  acceptVerificationRequest: (...args: unknown[]) => acceptVerificationRequest(...args),
  cancelVerification: (...args: unknown[]) => cancelVerification(...args),
  confirmSasVerification: (...args: unknown[]) => confirmSasVerification(...args),
  startSasVerification: (...args: unknown[]) => startSasVerification(...args),
  onVerificationRequest: vi.fn((callback: (request: VerificationRequestSummary) => void) => {
    verificationRequestCallback = callback;
    return Promise.resolve(() => {});
  }),
  onSasUpdate: vi.fn((flowId: string, callback: (update: SasUpdateEvent) => void) => {
    sasUpdateCallbacks.set(flowId, callback);
    return Promise.resolve(() => {
      sasUpdateCallbacks.delete(flowId);
    });
  }),
}));

function incomingRequest(overrides: Partial<VerificationRequestSummary> = {}) {
  return {
    flow_id: "flow-1",
    other_user_id: "@alice:localhost",
    other_device_id: "DEVICE1",
    ...overrides,
  };
}

function renderWithProviders(children: ReactNode, store = createStore()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <JotaiProvider store={store}>{children}</JotaiProvider>
    </QueryClientProvider>,
  );
}

describe("VerificationOverlay", () => {
  beforeEach(() => {
    verificationRequestCallback = undefined;
    sasUpdateCallbacks = new Map();
    acceptVerificationRequest.mockClear();
    cancelVerification.mockClear();
    confirmSasVerification.mockClear();
    startSasVerification.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing until a verification request arrives", () => {
    renderWithProviders(<VerificationOverlay />);
    expect(screen.queryByText("Verify new sign-in")).not.toBeInTheDocument();
  });

  it("shows the incoming request and moves to done after confirming", async () => {
    renderWithProviders(<VerificationOverlay />);

    act(() => {
      verificationRequestCallback?.(incomingRequest());
    });
    expect(screen.getByText("Verify new sign-in")).toBeInTheDocument();

    await act(async () => {
      screen.getByRole("button", { name: "Accept" }).click();
    });

    act(() => {
      sasUpdateCallbacks.get("flow-1")?.({
        state: "keys_exchanged",
        emojis: [{ symbol: "🐱", description: "Cat" }],
      });
    });
    expect(screen.getByText("Do these emoji match?")).toBeInTheDocument();

    await act(async () => {
      screen.getByRole("button", { name: "They match" }).click();
    });

    act(() => {
      sasUpdateCallbacks.get("flow-1")?.({ state: "done" });
    });
    expect(screen.getByText("Verified")).toBeInTheDocument();
  });

  it("does not let a stale auto-dismiss timer wipe out a newer verification request", () => {
    // Regression test: `done` schedules `setRequest(null)` 2s later with no
    // cleanup previously guarding it. If a second, unrelated verification
    // request arrives in that window, the stale timeout must not fire and
    // clobber it back to null.
    renderWithProviders(<VerificationOverlay />);

    act(() => {
      verificationRequestCallback?.(incomingRequest({ flow_id: "flow-1" }));
    });
    act(() => {
      sasUpdateCallbacks.get("flow-1")?.({ state: "done" });
    });
    expect(screen.getByText("Verified")).toBeInTheDocument();

    // A second request arrives 1s in, before the first's 2s dismiss timer.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      verificationRequestCallback?.(incomingRequest({ flow_id: "flow-2" }));
    });
    expect(screen.getByText("Verify new sign-in")).toBeInTheDocument();

    // The first request's stale timer fires here — it must not dismiss the
    // second, still-active request.
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByText("Verify new sign-in")).toBeInTheDocument();
  });

  it("closes settings when a verification request arrives", () => {
    // Radix's Dialog (the desktop settings shell) applies aria-hidden to
    // everything outside its own portal while open and traps focus there —
    // this overlay renders as a sibling of it, not inside it, so leaving
    // settings open would make the overlay invisible to assistive tech and
    // unreachable by keyboard despite being visually on top. Closing
    // settings is the fix, not z-index/pointer-events.
    const store = createStore();
    store.set(settingsOpenAtom, "devices");

    renderWithProviders(<VerificationOverlay />, store);

    act(() => {
      verificationRequestCallback?.(incomingRequest());
    });

    expect(store.get(settingsOpenAtom)).toBeNull();
  });
});
