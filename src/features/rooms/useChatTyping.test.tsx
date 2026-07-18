import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
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

// `presence_privacy_controls` on by default here — these tests exercise the
// hide_typing behavior itself, which only applies while the flag is on;
// the flag-off case (review fix) is covered by its own test below.
vi.mock("@/featureFlags", () => ({ useFlag: vi.fn(() => true) }));

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

  it("does not suppress typing when presence_privacy_controls is off, even with a stale hide_typing: true cached (review fix)", async () => {
    // Review fix (P2): `usePrivacySettings`'s cache can still hold a stale
    // hide_typing: true from before the flag was turned off (Labs, or a
    // remote kill switch) — neither the query key nor its enabled state
    // changes just because the flag flipped, so a plain cache read alone
    // doesn't notice. With the flag off, Rust's own enforcement already
    // falls back to defaults and the Privacy tab is hidden from Settings,
    // so there's no in-app way to un-toggle it — handleTypingInput must not
    // keep suppressing typing based on that now-inert cached value.
    const { useFlag } = await import("@/featureFlags");
    vi.mocked(useFlag).mockReturnValue(false);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getPrivacySettings.mockResolvedValue({ ...DEFAULT_SETTINGS, hide_typing: true });
    const { result } = renderHook(() => useChatTyping("!room:localhost", "@me:localhost"), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    // Waits for the query to actually settle with data (not just for the
    // fetch to have started) — otherwise `handleTypingInput` below could
    // run while `usePrivacySettings().data` is still `undefined`, which
    // would pass regardless of whether the flag gate itself works.
    await waitFor(() => expect(getPrivacySettings).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    sendTyping.mockClear();

    result.current.handleTypingInput();

    expect(sendTyping).toHaveBeenCalledWith("!room:localhost", true);
  });
});
