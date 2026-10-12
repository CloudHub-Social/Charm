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
  getUserProfile: vi.fn().mockResolvedValue({ room_avatar_url: "mxc://example.org/room-avatar" }),
  setRoomProfile: vi.fn().mockResolvedValue(undefined),
  startDirectMessage: vi.fn().mockResolvedValue("!dm:example.org"),
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

  it("rejects overlapping nickname submissions until the admitted update settles", async () => {
    let complete!: () => void;
    mocks.setDisplayName.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
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
    let first!: Promise<boolean>;
    act(() => {
      first = result.current.handleSlashCommand(parseSlashCommand("/nick Older", true)!);
    });
    await act(async () => {
      expect(await result.current.handleSlashCommand(parseSlashCommand("/nick Newer", true)!)).toBe(
        false,
      );
    });
    expect(mocks.setDisplayName).toHaveBeenCalledExactlyOnceWith("Older");
    expect(result.current.commandFeedback).toContain("already in progress");
    await act(async () => {
      complete();
      await first;
    });
    await act(async () => {
      await result.current.handleSlashCommand(parseSlashCommand("/nick Newer", true)!);
    });
    expect(mocks.setDisplayName.mock.calls).toEqual([["Older"], ["Newer"]]);
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
    expect(mocks.runCommand).toHaveBeenCalledExactlyOnceWith(
      room.room_id,
      "notice",
      ["hello"],
      null,
      null,
    );
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
    expect(mocks.runCommand).toHaveBeenCalledExactlyOnceWith(
      room.room_id,
      "notice",
      ["hello"],
      null,
      null,
    );
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
      } else if (command === "nick") {
        expect(mocks.invalidateQueries).toHaveBeenCalledTimes(2);
        expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["profile"] });
        expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["own-profile"] });
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

  it.each(["ignore", "unignore", "nick"] as const)(
    "does not invalidate settings queries when /%s fails",
    async (command) => {
      const mutation = {
        ignore: mocks.ignoreUser,
        unignore: mocks.unignoreUser,
        nick: mocks.setDisplayName,
      }[command];
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
      await act(async () => {
        await result.current.handleSlashCommand({
          command,
          args: [],
          text,
          mentionIds: ["@alice:example.org"],
        });
      });
      expect(mocks.sendMessage).toHaveBeenCalledExactlyOnceWith(room.room_id, expected, null, [
        "@alice:example.org",
      ]);
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
    ["plain", "hello", "hello"],
    ["shrug", "", "¯\\_(ツ)_/¯"],
    ["tableflip", "hello", "hello (╯°□°）╯︵ ┻━┻"],
  ] as const)("keeps a reply relation for /%s", async (command, text, expected) => {
    const room = makeRoomSummary();
    const replyTarget = {
      event_id: "$target",
      sender: "@alice:example.org",
      sender_display_name: "Alice",
      preview: "original",
    };
    const { result } = renderHook(() =>
      useMessageSend({
        room,
        editingEventId: null,
        replyTarget,
        setEditingEventId: vi.fn(),
        setReplyTarget: vi.fn(),
        stopTyping: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.handleSlashCommand({ command, args: [], text });
    });

    expect(mocks.sendReply).toHaveBeenCalledExactlyOnceWith(
      room.room_id,
      "$target",
      expected,
      null,
      null,
    );
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["me", "notice"] as const)("passes the reply target through /%s", async (command) => {
    const room = makeRoomSummary();
    mocks.runCommand.mockResolvedValueOnce({ status: "success" });
    const { result } = renderHook(() =>
      useMessageSend({
        room,
        editingEventId: null,
        replyTarget: {
          event_id: "$target",
          sender: "@alice:example.org",
          sender_display_name: "Alice",
          preview: "original",
        },
        setEditingEventId: vi.fn(),
        setReplyTarget: vi.fn(),
        stopTyping: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.handleSlashCommand({ command, args: ["hello"] });
    });

    expect(mocks.runCommand).toHaveBeenCalledExactlyOnceWith(
      room.room_id,
      command,
      ["hello"],
      "$target",
      null,
    );
  });

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

describe("room nickname and direct-message commands", () => {
  const userId = "@self:example.org";
  const room = makeRoomSummary();
  const replyTarget = {
    event_id: "$reply",
    sender: "@alice:example.org",
    sender_display_name: "Alice",
    preview: "keep this reply",
  };

  function setup() {
    const setReplyTarget = vi.fn();
    const onNavigateToRoom = vi.fn();
    const mutationsBlockedRef = { current: false };
    const hook = renderHook(
      ({ activeRoom, currentUserId }) =>
        useMessageSend({
          room: activeRoom,
          currentUserId,
          editingEventId: null,
          replyTarget,
          setEditingEventId: vi.fn(),
          setReplyTarget,
          stopTyping: vi.fn(),
          onNavigateToRoom,
          mutationsBlockedRef,
        }),
      { initialProps: { activeRoom: room, currentUserId: userId } },
    );
    return { ...hook, setReplyTarget, onNavigateToRoom, mutationsBlockedRef };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useFlag.mockReturnValue(true);
  });

  it.each(["myroomnick", "startdm"] as const)(
    "rejects missing /%s arguments, disabled dispatch and mutation locks",
    async (command) => {
      const { result, rerender, mutationsBlockedRef } = setup();
      await act(async () => {
        expect(
          await result.current.handleSlashCommand(parseSlashCommand(`/${command}`, true)!),
        ).toBe(false);
      });
      expect(result.current.commandFeedback).toContain(`Usage: /${command}`);
      mocks.useFlag.mockReturnValue(false);
      rerender({ activeRoom: room, currentUserId: userId });
      await act(async () => {
        await result.current.handleSlashCommand(
          parseSlashCommand(`/${command} @alice:example.org`, true)!,
        );
        await result.current.handleSlashCommand(
          parseSlashCommand(`/${command} @alice:example.org`)!,
        );
      });
      expect(result.current.commandFeedback).toContain("unavailable");
      mocks.useFlag.mockReturnValue(true);
      rerender({ activeRoom: room, currentUserId: userId });
      mutationsBlockedRef.current = true;
      await act(async () => {
        await result.current.handleSlashCommand(
          parseSlashCommand(`/${command} @alice:example.org`, true)!,
        );
      });
      expect(mocks.getUserProfile).not.toHaveBeenCalled();
      expect(mocks.setRoomProfile).not.toHaveBeenCalled();
      expect(mocks.startDirectMessage).not.toHaveBeenCalled();
    },
  );

  it.each(["mxc://example.org/room-avatar", null])(
    "changes only the room nickname, preserving avatar %s and reply context",
    async (avatarUrl) => {
      mocks.getUserProfile.mockResolvedValueOnce({
        room_avatar_url: avatarUrl,
        avatar_url: "mxc://example.org/global",
      });
      const { result, setReplyTarget, onNavigateToRoom } = setup();
      await act(async () => {
        expect(
          await result.current.handleSlashCommand(
            parseSlashCommand("/myroomnick Room Name", true)!,
          ),
        ).toBe(true);
      });
      expect(mocks.getUserProfile).toHaveBeenCalledExactlyOnceWith(userId, room.room_id, false);
      expect(mocks.setRoomProfile).toHaveBeenCalledExactlyOnceWith(
        room.room_id,
        "Room Name",
        avatarUrl,
      );
      expect(mocks.invalidateQueries).toHaveBeenCalledExactlyOnceWith({
        queryKey: ["user-profile", userId, userId, room.room_id],
      });
      expect(mocks.setDisplayName).not.toHaveBeenCalled();
      expect(mocks.sendMessage).not.toHaveBeenCalled();
      expect(mocks.sendReply).not.toHaveBeenCalled();
      expect(mocks.runCommand).not.toHaveBeenCalled();
      expect(setReplyTarget).not.toHaveBeenCalled();
      expect(onNavigateToRoom).not.toHaveBeenCalled();
    },
  );

  it("opens the SDK-returned DM without sending a message or consuming a reply", async () => {
    const { result, setReplyTarget, onNavigateToRoom } = setup();
    await act(async () => {
      expect(
        await result.current.handleSlashCommand(
          parseSlashCommand("/startdm @alice:example.org", true)!,
        ),
      ).toBe(true);
    });
    expect(mocks.startDirectMessage).toHaveBeenCalledExactlyOnceWith("@alice:example.org");
    expect(onNavigateToRoom).toHaveBeenCalledExactlyOnceWith(
      "!dm:example.org",
      expect.any(AbortSignal),
    );
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.sendReply).not.toHaveBeenCalled();
    expect(mocks.runCommand).not.toHaveBeenCalled();
    expect(setReplyTarget).not.toHaveBeenCalled();
    expect(mocks.invalidateQueries).not.toHaveBeenCalled();
  });

  it("rejects extra DM arguments", async () => {
    const { result } = setup();
    await act(async () => {
      expect(
        await result.current.handleSlashCommand(
          parseSlashCommand("/startdm @alice:example.org extra", true)!,
        ),
      ).toBe(false);
    });
    expect(result.current.commandFeedback).toBe("Usage: /startdm <user id>");
    expect(mocks.startDirectMessage).not.toHaveBeenCalled();
  });

  it.each(["getUserProfile", "setRoomProfile", "startDirectMessage"] as const)(
    "shows inline failure without invalidation, navigation, or reply loss when %s fails",
    async (operation) => {
      mocks[operation].mockRejectedValueOnce(new Error("private arguments must not be logged"));
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const command = operation === "startDirectMessage" ? "startdm" : "myroomnick";
      const { result, setReplyTarget, onNavigateToRoom } = setup();
      await act(async () => {
        expect(
          await result.current.handleSlashCommand(
            parseSlashCommand(`/${command} @alice:example.org`, true)!,
          ),
        ).toBe(false);
      });
      expect(result.current.commandFeedback).toContain(`Could not complete /${command}`);
      expect(mocks.invalidateQueries).not.toHaveBeenCalled();
      expect(onNavigateToRoom).not.toHaveBeenCalled();
      expect(setReplyTarget).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      log.mockRestore();
    },
  );

  it.each(["myroomnick", "startdm"] as const)(
    "rejects duplicate /%s while in flight and admits a later retry",
    async (command) => {
      let resolve!: (value: never) => void;
      const operation = command === "myroomnick" ? mocks.getUserProfile : mocks.startDirectMessage;
      operation.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const { result } = setup();
      const parsed = parseSlashCommand(`/${command} @alice:example.org`, true)!;
      let pending!: Promise<boolean>;
      act(() => {
        pending = result.current.handleSlashCommand(parsed);
      });
      await act(async () => {
        expect(await result.current.handleSlashCommand(parsed)).toBe(false);
      });
      expect(operation).toHaveBeenCalledTimes(1);
      expect(result.current.commandFeedback).toContain("already");
      await act(async () => {
        resolve(
          (command === "myroomnick" ? { room_avatar_url: null } : "!dm:example.org") as never,
        );
        await pending;
        await result.current.handleSlashCommand(parsed);
      });
      expect(operation).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["room", "account", "away-and-back", "lock", "flag", "unmount"] as const)(
    "does not write a nickname after its profile read becomes stale (%s)",
    async (change) => {
      let resolve!: (value: { room_avatar_url: null }) => void;
      mocks.getUserProfile.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const { result, rerender, unmount, mutationsBlockedRef } = setup();
      let pending!: Promise<boolean>;
      act(() => {
        pending = result.current.handleSlashCommand(
          parseSlashCommand("/myroomnick New Name", true)!,
        );
      });
      if (change === "room" || change === "away-and-back") {
        rerender({ activeRoom: { ...room, room_id: "!next:example.org" }, currentUserId: userId });
        if (change === "away-and-back") rerender({ activeRoom: room, currentUserId: userId });
      } else if (change === "account") {
        rerender({ activeRoom: room, currentUserId: "@other:example.org" });
      } else if (change === "lock") {
        mutationsBlockedRef.current = true;
      } else if (change === "flag") {
        mocks.useFlag.mockReturnValue(false);
        rerender({ activeRoom: room, currentUserId: userId });
      } else {
        unmount();
      }
      await act(async () => {
        resolve({ room_avatar_url: null });
        expect(await pending).toBe(false);
      });
      expect(mocks.setRoomProfile).not.toHaveBeenCalled();
      expect(mocks.invalidateQueries).not.toHaveBeenCalled();
    },
  );

  it.each(["room", "account", "away-and-back", "unmount"] as const)(
    "does not navigate after a DM result becomes stale (%s)",
    async (change) => {
      let resolve!: (value: string) => void;
      mocks.startDirectMessage.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const { result, rerender, unmount, onNavigateToRoom } = setup();
      let pending!: Promise<boolean>;
      act(() => {
        pending = result.current.handleSlashCommand(
          parseSlashCommand("/startdm @alice:example.org", true)!,
        );
      });
      if (change === "room" || change === "away-and-back") {
        rerender({ activeRoom: { ...room, room_id: "!next:example.org" }, currentUserId: userId });
        if (change === "away-and-back") rerender({ activeRoom: room, currentUserId: userId });
      } else if (change === "account") {
        rerender({ activeRoom: room, currentUserId: "@other:example.org" });
      } else {
        unmount();
      }
      await act(async () => {
        resolve("!dm:example.org");
        expect(await pending).toBe(false);
      });
      expect(onNavigateToRoom).not.toHaveBeenCalled();
    },
  );

  it("aborts the normal room refresh navigation if the source room changes", async () => {
    const { result, rerender, onNavigateToRoom } = setup();
    await act(async () => {
      await result.current.handleSlashCommand(
        parseSlashCommand("/startdm @alice:example.org", true)!,
      );
    });
    const signal = onNavigateToRoom.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    rerender({ activeRoom: { ...room, room_id: "!next:example.org" }, currentUserId: userId });
    expect(signal.aborted).toBe(true);
  });

  it.each([false, true])(
    "ignores a late nickname write completion (failure %s)",
    async (failure) => {
      let complete!: () => void;
      mocks.setRoomProfile.mockImplementationOnce(
        () =>
          new Promise<void>((resolve, reject) => {
            complete = () => (failure ? reject(new Error("Late failure")) : resolve());
          }),
      );
      const { result, rerender } = setup();
      let pending!: Promise<boolean>;
      await act(async () => {
        pending = result.current.handleSlashCommand(parseSlashCommand("/myroomnick Name", true)!);
        await Promise.resolve();
      });
      expect(mocks.setRoomProfile).toHaveBeenCalledTimes(1);
      rerender({ activeRoom: room, currentUserId: "@other:example.org" });
      await act(async () => {
        complete();
        expect(await pending).toBe(false);
      });
      expect(result.current.commandFeedback).toBeNull();
      expect(mocks.invalidateQueries).not.toHaveBeenCalled();
    },
  );
});
