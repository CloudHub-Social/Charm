import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeRoomSummary } from "./testFixtures";
import { useMessageSend } from "./useMessageSend";
import { parseSlashCommand } from "./slashCommands";

const mocks = vi.hoisted(() => ({
  editMessage: vi.fn().mockResolvedValue(undefined),
  sendReply: vi.fn().mockResolvedValue("reply-transaction"),
  sendMessage: vi.fn().mockResolvedValue("send-transaction"),
  runCommand: vi.fn(),
  unbanMember: vi.fn().mockResolvedValue(undefined),
  setDisplayName: vi.fn().mockResolvedValue(undefined),
  ignoreUser: vi.fn().mockResolvedValue(undefined),
  unignoreUser: vi.fn().mockResolvedValue(undefined),
  joinRoom: vi.fn().mockResolvedValue({ room_id: "!joined:example.org", is_space: false }),
  useFlag: vi.fn(() => true),
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/matrix", () => mocks);
vi.mock("@/featureFlags", () => ({ useFlag: () => mocks.useFlag() }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => mocks }));

describe("formatted composer submission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useFlag.mockReturnValue(true);
  });

  it("gates /notice submission and preserves backend failure feedback", async () => {
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
    mocks.useFlag.mockReturnValue(false);
    rerender();
    await act(async () => {
      expect(await result.current.handleSlashCommand({ command: "notice", args: ["hello"] })).toBe(
        false,
      );
    });
    expect(mocks.runCommand).not.toHaveBeenCalled();

    mocks.useFlag.mockReturnValue(true);
    mocks.runCommand.mockResolvedValueOnce({ status: "error", message: "Cannot send notice" });
    rerender();
    await act(async () => {
      expect(await result.current.handleSlashCommand({ command: "notice", args: ["hello"] })).toBe(
        false,
      );
    });
    expect(mocks.runCommand).toHaveBeenCalledExactlyOnceWith(room.room_id, "notice", ["hello"]);
    expect(result.current.commandFeedback).toBe("Cannot send notice");
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("does not apply a late /notice result to the next room", async () => {
    const room = makeRoomSummary();
    let resolveCommand!: (value: { status: "success" }) => void;
    mocks.runCommand.mockReturnValueOnce(
      new Promise<{ status: "success" }>((resolve) => {
        resolveCommand = resolve;
      }),
    );
    const { result, rerender } = renderHook(
      ({ activeRoom }) =>
        useMessageSend({
          room: activeRoom,
          editingEventId: null,
          replyTarget: null,
          setEditingEventId: vi.fn(),
          setReplyTarget: vi.fn(),
          stopTyping: vi.fn(),
        }),
      { initialProps: { activeRoom: room } },
    );
    let submission!: Promise<boolean>;
    act(() => {
      submission = result.current.handleSlashCommand({ command: "notice", args: ["hello"] });
    });
    rerender({ activeRoom: { ...room, room_id: "!next:example.org" } });
    await act(async () => {
      resolveCommand({ status: "success" });
      expect(await submission).toBe(false);
    });
    expect(result.current.commandFeedback).toBeNull();
    expect(mocks.runCommand).toHaveBeenCalledExactlyOnceWith(room.room_id, "notice", ["hello"]);
  });

  it.each(["unban", "nick", "ignore", "unignore"] as const)(
    "routes /%s to its existing action only with the flag enabled",
    async (command) => {
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
      const expected = {
        unban: mocks.unbanMember,
        nick: mocks.setDisplayName,
        ignore: mocks.ignoreUser,
        unignore: mocks.unignoreUser,
      }[command];
      await act(async () => {
        await result.current.handleSlashCommand({ command, action: true, args: [] });
      });
      expect(expected).not.toHaveBeenCalled();
      expect(result.current.commandFeedback).toContain(`Usage: /${command}`);
      await act(async () => {
        await result.current.handleSlashCommand({
          command,
          action: true,
          args: ["@alice:example.org"],
        });
      });
      expect(expected).toHaveBeenCalledExactlyOnceWith(
        ...(command === "unban"
          ? [room.room_id, "@alice:example.org", undefined]
          : ["@alice:example.org"]),
      );
      expect(mocks.sendMessage).not.toHaveBeenCalled();
      expect(mocks.runCommand).not.toHaveBeenCalled();
      if (command === "ignore" || command === "unignore") {
        expect(mocks.invalidateQueries).toHaveBeenCalledExactlyOnceWith({
          queryKey: ["settings", "ignored-users"],
        });
      } else {
        expect(mocks.invalidateQueries).not.toHaveBeenCalled();
      }
      expected.mockClear();
      mocks.useFlag.mockReturnValue(false);
      rerender();
      await act(async () => {
        await result.current.handleSlashCommand({
          command,
          action: true,
          args: ["@alice:example.org"],
        });
      });
      expect(expected).not.toHaveBeenCalled();
    },
  );

  it.each(["ignore", "unignore"] as const)(
    "does not invalidate the settings list when /%s fails",
    async (command) => {
      const mutation = command === "ignore" ? mocks.ignoreUser : mocks.unignoreUser;
      mutation.mockRejectedValueOnce(new Error("Request failed"));
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
        expect(
          await result.current.handleSlashCommand({
            command,
            action: true,
            args: ["@alice:example.org"],
          }),
        ).toBe(false);
      });
      expect(mocks.invalidateQueries).not.toHaveBeenCalled();
    },
  );

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

  it.each([
    ["/plain hello", true],
    ["/shrug", true],
    ["/tableflip", true],
    ["/me waves", true],
    ["/notice hello", true],
    ["/nick Alice", false],
    ["/ignore @other:example.org", false],
    ["/topic new topic", false],
  ] as const)("consumes reply context only for message-sending %s", async (input, clearsReply) => {
    const setReplyTarget = vi.fn();
    const { result } = renderHook(() =>
      useMessageSend({
        room: makeRoomSummary(),
        editingEventId: null,
        replyTarget: {
          event_id: "$target",
          sender: "@alice:example.org",
          sender_display_name: "Alice",
          preview: "original",
        },
        setEditingEventId: vi.fn(),
        setReplyTarget,
        stopTyping: vi.fn(),
      }),
    );
    mocks.runCommand.mockResolvedValue({ status: "success" });
    const parsed = parseSlashCommand(input, true);
    expect(parsed).not.toBeNull();
    await act(async () => {
      await result.current.handleSlashCommand(parsed!);
    });
    if (clearsReply) expect(setReplyTarget).toHaveBeenCalledExactlyOnceWith(null);
    else expect(setReplyTarget).not.toHaveBeenCalled();
  });

  it.each(["#room:example.org", "!room:example.org"])(
    "routes /join %s through the existing join boundary",
    async (target) => {
      const setReplyTarget = vi.fn();
      const { result, rerender } = renderHook(() =>
        useMessageSend({
          room: makeRoomSummary(),
          editingEventId: null,
          replyTarget: null,
          setEditingEventId: vi.fn(),
          setReplyTarget,
          stopTyping: vi.fn(),
        }),
      );
      for (const args of [[], [target, "extra"]]) {
        await act(async () => {
          await result.current.handleSlashCommand({ command: "join", action: true, args });
        });
        expect(result.current.commandFeedback).toBe("Usage: /join <room id or alias>");
      }
      expect(mocks.joinRoom).not.toHaveBeenCalled();
      await act(async () => {
        await result.current.handleSlashCommand({ command: "join", action: true, args: [target] });
      });
      expect(mocks.joinRoom).toHaveBeenCalledExactlyOnceWith(target);
      expect(mocks.sendMessage).not.toHaveBeenCalled();
      expect(setReplyTarget).not.toHaveBeenCalled();
      mocks.joinRoom.mockClear();
      mocks.useFlag.mockReturnValue(false);
      rerender();
      await act(async () => {
        await result.current.handleSlashCommand({ command: "join", action: true, args: [target] });
      });
      expect(mocks.joinRoom).not.toHaveBeenCalled();
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

  it.each([
    ["edit", false],
    ["reply", false],
    ["edit", true],
    ["reply", true],
  ] as const)("preserves spoilers and mentions on %s with parity %s", async (mode, enabled) => {
    mocks.useFlag.mockReturnValue(enabled);
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
