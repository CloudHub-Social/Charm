import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRoomSummary } from "./testFixtures";
import { useMessageSend } from "./useMessageSend";

const mocks = vi.hoisted(() => ({
  editMessage: vi.fn().mockResolvedValue(undefined),
  sendReply: vi.fn().mockResolvedValue("reply-transaction"),
  sendMessage: vi.fn().mockResolvedValue("send-transaction"),
  runCommand: vi.fn(),
  useFlag: vi.fn(() => true),
}));
vi.mock("@/lib/matrix", () => mocks);
vi.mock("@/featureFlags", () => ({ useFlag: () => mocks.useFlag() }));

describe("formatted composer submission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useFlag.mockReturnValue(true);
  });

  it.each([
    ["plain", "<b>literal</b>", "<b>literal</b>"],
    ["shrug", "", "¯\\_(ツ)_/¯"],
    ["tableflip", "hello", "hello (╯°□°）╯︵ ┻━┻"],
  ] as const)(
    "sends /%s as plain text through the existing queue",
    async (command, text, expected) => {
      const room = makeRoomSummary();
      const { result, rerender } = renderHook(() =>
        useMessageSend({
          room,
          editingEventId: null,
          replyTarget: null,
          setEditingEventId: vi.fn(),
          setReplyTarget: vi.fn(),
          stopTyping: vi.fn(),
        }),
      );
      await act(async () => {
        await result.current.handleSlashCommand({ command, args: [], text });
      });
      expect(mocks.sendMessage).toHaveBeenCalledExactlyOnceWith(room.room_id, expected, null, null);
      expect(mocks.runCommand).not.toHaveBeenCalled();
      mocks.sendMessage.mockClear();
      mocks.useFlag.mockReturnValue(false);
      rerender();
      await act(async () => {
        await result.current.handleSlashCommand({ command, args: [], text });
      });
      expect(mocks.sendMessage).not.toHaveBeenCalled();
    },
  );

  it("does not send an empty /plain message", async () => {
    const { result } = renderHook(() =>
      useMessageSend({
        room: makeRoomSummary(),
        editingEventId: null,
        replyTarget: null,
        setEditingEventId: vi.fn(),
        setReplyTarget: vi.fn(),
        stopTyping: vi.fn(),
      }),
    );
    await act(async () => {
      await result.current.handleSlashCommand({ command: "plain", args: [], text: "" });
    });
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(result.current.commandFeedback).toBe("Usage: /plain <message>");
  });

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
