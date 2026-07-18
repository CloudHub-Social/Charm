import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatTyping } from "./useChatTyping";
import type { PrivacySettings } from "@/lib/matrix";

const sendTyping = vi.fn();
const getPrivacySettings = vi.fn();
const PRIVACY_SETTINGS_QUERY_KEY = ["privacySettings"];

vi.mock("@/lib/matrix", () => ({
  sendTyping: (...args: unknown[]) => sendTyping(...args),
  getPrivacySettings: (...args: unknown[]) => getPrivacySettings(...args),
  onTypingUpdate: vi.fn().mockResolvedValue(() => {}),
}));

const DEFAULT_SETTINGS: PrivacySettings = {
  hide_read_receipts: false,
  hide_typing: false,
  appear_offline: false,
  idle_timeout_minutes: null,
};

beforeEach(() => {
  sendTyping.mockReset().mockResolvedValue(undefined);
  getPrivacySettings.mockReset().mockResolvedValue(DEFAULT_SETTINGS);
});

describe("useChatTyping", () => {
  it("withdraws an already-sent typing notice once hide_typing turns on (review fix)", async () => {
    // Review fix: send_typing's own Rust enforcement only suppresses
    // *future* typing sends once hide_typing is on — it can't retroactively
    // withdraw a notice already sent before the toggle flipped. This hook
    // must send an explicit stop-typing the moment it observes the setting
    // turn on, while it's still mounted for the same room.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useChatTyping("!room:localhost", "@me:localhost"), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() => expect(getPrivacySettings).toHaveBeenCalled());
    expect(sendTyping).not.toHaveBeenCalled();

    client.setQueryData(PRIVACY_SETTINGS_QUERY_KEY, { ...DEFAULT_SETTINGS, hide_typing: true });

    await waitFor(() => expect(sendTyping).toHaveBeenCalledWith("!room:localhost", false));
  });

  it("does not send typing:true from handleTypingInput while hide_typing is on (review fix)", async () => {
    // Review fix (P2): the withdrawal effect above only fires once, right
    // when hide_typing flips on — composer input arriving afterward (e.g.
    // while a privacy write is still queued or hasn't reached Rust yet)
    // used to still call sendTyping(roomId, true) on every keystroke,
    // sending a fresh public typing notice moments after the user asked to
    // hide it. handleTypingInput must itself skip sending while hide_typing
    // is on, not just rely on Rust's own (persisted-settings-based)
    // enforcement to suppress it.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getPrivacySettings.mockResolvedValue({ ...DEFAULT_SETTINGS, hide_typing: true });
    const { result } = renderHook(() => useChatTyping("!room:localhost", "@me:localhost"), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    // Waits for the query to actually settle with hide_typing: true (not
    // just for the fetch to have started) — the withdrawal effect above
    // firing sendTyping(roomId, false) is the observable signal that
    // happened, same as the "withdraws an already-sent typing notice" test.
    await waitFor(() => expect(sendTyping).toHaveBeenCalledWith("!room:localhost", false));
    sendTyping.mockClear();

    result.current.handleTypingInput();

    expect(sendTyping).not.toHaveBeenCalledWith("!room:localhost", true);
  });

  it("does not send a stop-typing notice when hide_typing stays off", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useChatTyping("!room:localhost", "@me:localhost"), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() => expect(getPrivacySettings).toHaveBeenCalled());

    client.setQueryData(PRIVACY_SETTINGS_QUERY_KEY, {
      ...DEFAULT_SETTINGS,
      hide_read_receipts: true,
    });

    expect(sendTyping).not.toHaveBeenCalled();
  });
});
