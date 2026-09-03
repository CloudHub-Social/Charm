import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRoomSummary } from "./testFixtures";
import { useMessageSend } from "./useMessageSend";

const mocks = vi.hoisted(() => ({
  editMessage: vi.fn().mockResolvedValue(undefined),
  sendReply: vi.fn().mockResolvedValue("reply-transaction"),
  sendMessage: vi.fn().mockResolvedValue("send-transaction"),
  runCommand: vi.fn(),
}));
vi.mock("@/lib/matrix", () => mocks);

describe("formatted composer submission", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["edit", "reply"] as const)("preserves spoilers and mentions on %s", async (mode) => {
    const room = makeRoomSummary();
    const content = {
      body: "secret",
      formattedBody: '<span data-mx-spoiler="">secret</span>',
      mentions: ["@alice:example.org"],
    };
    const { result } = renderHook(() =>
      useMessageSend({
        room,
        editingEventId: mode === "edit" ? "$target" : null,
        replyTarget:
          mode === "reply"
            ? {
                event_id: "$target",
                sender: "@alice:example.org",
                sender_display_name: "Alice",
                preview: "original",
              }
            : null,
        setEditingEventId: vi.fn(),
        setReplyTarget: vi.fn(),
        stopTyping: vi.fn(),
      }),
    );
    await act(async () => {
      await result.current.handleComposerSubmit(content);
    });
    const expected = mode === "edit" ? mocks.editMessage : mocks.sendReply;
    expect(expected).toHaveBeenCalledExactlyOnceWith(
      room.room_id,
      "$target",
      content.body,
      content.formattedBody,
      content.mentions,
    );
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});
