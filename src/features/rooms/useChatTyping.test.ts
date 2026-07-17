import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatTyping } from "./useChatTyping";
import { setPrivacySettings } from "@/features/privacy/privacySettings";

const sendTyping = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/matrix", () => ({
  onTypingUpdate: () => Promise.resolve(() => undefined),
  sendTyping: (...args: unknown[]) => sendTyping(...args),
}));

vi.mock("@/lib/platform", () => ({
  isTauri: () => false,
}));

describe("useChatTyping — hide typing indicators (Spec 40)", () => {
  beforeEach(async () => {
    sendTyping.mockClear();
    await setPrivacySettings({ hideTyping: false });
  });

  afterEach(async () => {
    await setPrivacySettings({ hideTyping: false });
  });

  it("sends a typing notification by default", () => {
    const { result } = renderHook(() => useChatTyping("!room:example.org", "@me:example.org"));

    act(() => {
      result.current.handleTypingInput();
    });

    expect(sendTyping).toHaveBeenCalledWith("!room:example.org", true);
  });

  it("never emits m.typing while the privacy setting is on", async () => {
    await setPrivacySettings({ hideTyping: true });
    const { result } = renderHook(() => useChatTyping("!room:example.org", "@me:example.org"));

    act(() => {
      result.current.handleTypingInput();
    });

    expect(sendTyping).not.toHaveBeenCalledWith("!room:example.org", true);
  });
});
