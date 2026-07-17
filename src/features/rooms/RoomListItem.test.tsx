import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomListItem, roomListItemPropsEqual } from "./RoomListItem";
import { makeRoomSummary } from "./testFixtures";
import { showUnreadCountsAtom } from "@/features/appearance/atoms";
import { featureFlagTestHooks } from "@/featureFlags";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

const getPresence = vi.fn().mockResolvedValue(null);
const onPresenceUpdate = vi.fn().mockResolvedValue(() => {});

vi.mock("@/lib/matrix", () => ({
  getPresence: (...args: unknown[]) => getPresence(...args),
  onPresenceUpdate: (...args: unknown[]) => onPresenceUpdate(...args),
}));

afterEach(() => {
  getPresence.mockClear();
  onPresenceUpdate.mockClear();
  featureFlagTestHooks.reset();
  // Unconditional, not just at the end of the one test that stubs `Image`
  // below: if an assertion in that test throws before it reaches its own
  // cleanup, the stub would otherwise leak into every later test in this
  // file (and, since `vi.stubGlobal` mutates the shared global object,
  // possibly other files run in the same worker).
  vi.unstubAllGlobals();
});

const room = makeRoomSummary();

function renderWithAmbientUnreadCount(unreadRoom = room) {
  featureFlagTestHooks.setCache({ room_list_unread_filter: true });
  const store = createStore();
  store.set(showUnreadCountsAtom, true);
  return render(
    <Provider store={store}>
      <RoomListItem room={unreadRoom} active={false} onSelect={() => {}} />
    </Provider>,
  );
}

/**
 * jsdom's real `Image` never fires `load`/`error` (no network stack), so
 * Radix's `AvatarImage` — which only renders the `<img>` once its internal
 * loading-status hook observes a load — never mounts one in tests by
 * default. Stubbing `Image` to resolve on the next microtask lets tests
 * that care about the rendered image opt in.
 */
class MockImage extends EventTarget {
  complete = false;
  naturalWidth = 0;
  set src(_value: string) {
    queueMicrotask(() => {
      this.complete = true;
      this.naturalWidth = 1;
      this.dispatchEvent(new Event("load"));
    });
  }
}

describe("RoomListItem", () => {
  it("renders the room name", () => {
    render(<RoomListItem room={room} active={false} onSelect={() => {}} />);
    expect(screen.getByText("general")).toBeInTheDocument();
  });

  it("shows an unread badge when there are unread messages", () => {
    render(
      <RoomListItem
        room={makeRoomSummary({ unread_count: 3, has_unread: true })}
        active={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("hides the unread badge when there are no unread messages", () => {
    render(<RoomListItem room={room} active={false} onSelect={() => {}} />);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("calls onSelect when clicked", () => {
    const onSelect = vi.fn();
    render(<RoomListItem room={room} active={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("renders bold text and a marked-unread dot when has_unread is true, even with a zero notification count", () => {
    render(
      <RoomListItem
        room={makeRoomSummary({ has_unread: true, is_marked_unread: true })}
        active={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("general")).toHaveClass("font-bold");
    expect(screen.getByText("Marked unread")).toBeInTheDocument();
    // `has_unread` is derived true whenever `is_marked_unread` is true (see
    // `has_unread` in rooms.rs), so without the `!is_marked_unread` guard the
    // plain unread dot would also render alongside "Marked unread" here.
    expect(screen.queryByText("Unread")).not.toBeInTheDocument();
  });

  it("shows the numeric badge (not the plain dot) when unread_count > 0", () => {
    render(
      <RoomListItem
        room={makeRoomSummary({ unread_count: 3, has_unread: true })}
        active={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.queryByText("Unread")).not.toBeInTheDocument();
  });

  it("shows a plain unread dot when has_unread is true but unread_count is 0", () => {
    render(
      <RoomListItem
        room={makeRoomSummary({ has_unread: true, unread_count: 0 })}
        active={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("Unread")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("shows the ambient unread message total when the display preference is enabled", () => {
    renderWithAmbientUnreadCount(
      makeRoomSummary({ has_unread: true, unread_count: 0, unread_messages: 12 }),
    );

    expect(screen.getByLabelText("12 unread messages")).toHaveTextContent("12");
    expect(screen.queryByText("Unread")).not.toBeInTheDocument();
  });

  it("keeps notification counts visually primary when ambient counts are enabled", () => {
    renderWithAmbientUnreadCount(
      makeRoomSummary({ has_unread: true, unread_count: 2, unread_messages: 12 }),
    );

    expect(screen.getByLabelText("2 notifications")).toHaveTextContent("2");
    expect(screen.queryByLabelText("12 unread messages")).not.toBeInTheDocument();
  });

  it("honors the authoritative unread suppression for muted ambient messages", () => {
    renderWithAmbientUnreadCount(
      makeRoomSummary({
        has_unread: false,
        is_muted: true,
        unread_count: 0,
        unread_messages: 12,
      }),
    );

    expect(screen.queryByLabelText("12 unread messages")).not.toBeInTheDocument();
    expect(screen.queryByText("Unread")).not.toBeInTheDocument();
  });

  it("shows neither the numeric badge nor the plain dot when has_unread is false", () => {
    render(
      <RoomListItem
        room={makeRoomSummary({ has_unread: false, unread_count: 0 })}
        active={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.queryByText("Unread")).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("shows a muted indicator when is_muted is true", () => {
    render(
      <RoomListItem
        room={makeRoomSummary({ is_muted: true })}
        active={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByLabelText("Muted")).toBeInTheDocument();
  });

  it("does not render a context menu without any action handlers", () => {
    render(<RoomListItem room={room} active={false} onSelect={() => {}} />);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens a context menu with favourite/mark actions when handlers are provided", async () => {
    const onToggleFavourite = vi.fn();
    render(
      <RoomListItem
        room={room}
        active={false}
        onSelect={() => {}}
        onToggleFavourite={onToggleFavourite}
        onMarkRead={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("button"));
    const item = await screen.findByText("Add to Favourites");
    fireEvent.click(item);
    expect(onToggleFavourite).toHaveBeenCalledOnce();
  });

  it("opens a context menu with Remove from space when onRemoveFromSpace is provided", async () => {
    const onRemoveFromSpace = vi.fn();
    render(
      <RoomListItem
        room={room}
        active={false}
        onSelect={() => {}}
        onRemoveFromSpace={onRemoveFromSpace}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("button"));
    const item = await screen.findByText("Remove from space");
    fireEvent.click(item);
    expect(onRemoveFromSpace).toHaveBeenCalledOnce();
  });

  it("renders an avatar image when the room has a resolved avatar_path", async () => {
    vi.stubGlobal("Image", MockImage);
    const { container } = render(
      <RoomListItem
        room={makeRoomSummary({ avatar_path: "/cache/media/room-avatar.png" })}
        active={false}
        onSelect={() => {}}
      />,
    );
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "asset://localhost//cache/media/room-avatar.png",
    );
  });

  it("renders initials, not an image, when there's no avatar_path", () => {
    const { container } = render(
      <RoomListItem
        room={makeRoomSummary({ avatar_path: null })}
        active={false}
        onSelect={() => {}}
      />,
    );
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(screen.getByText("GE")).toBeInTheDocument();
  });

  it("shows a presence dot for a direct room with a resolved peer", async () => {
    getPresence.mockResolvedValueOnce({
      user_id: "@peer:localhost",
      presence: "online",
      status_msg: null,
      last_active_ago_ms: null,
    });
    render(
      <RoomListItem
        room={makeRoomSummary({ is_direct: true, dm_peer_user_id: "@peer:localhost" })}
        active={false}
        onSelect={() => {}}
      />,
    );
    expect(await screen.findByText("Online")).toBeInTheDocument();
  });

  it("shows no presence dot for a group room", () => {
    render(
      <RoomListItem
        room={makeRoomSummary({ is_direct: false })}
        active={false}
        onSelect={() => {}}
      />,
    );
    expect(getPresence).not.toHaveBeenCalled();
    expect(screen.queryByText("Online")).not.toBeInTheDocument();
  });

  describe("last-message preview", () => {
    function renderWithPreview(overrides: Parameters<typeof makeRoomSummary>[0] = {}) {
      featureFlagTestHooks.setCache({ room_list_message_preview: true });
      return render(
        <RoomListItem
          room={makeRoomSummary({
            last_message_preview: {
              sender_id: "@alice:example.org",
              sender_display_name: "Alice",
              text: "see you at 6",
            },
            ...overrides,
          })}
          active={false}
          onSelect={() => {}}
        />,
      );
    }

    it("renders the sender label and text when the flag is on", () => {
      renderWithPreview();
      expect(screen.getByText("Alice:", { exact: false })).toBeInTheDocument();
      expect(screen.getByText("see you at 6", { exact: false })).toBeInTheDocument();
    });

    it("falls back to the sender's localpart when no display name is known", () => {
      renderWithPreview({
        last_message_preview: {
          sender_id: "@bob:example.org",
          sender_display_name: null,
          text: "hi there",
        },
      });
      expect(screen.getByText("bob:", { exact: false })).toBeInTheDocument();
    });

    it("does not render a preview when there is none", () => {
      featureFlagTestHooks.setCache({ room_list_message_preview: true });
      render(
        <RoomListItem
          room={makeRoomSummary({ last_message_preview: null })}
          active={false}
          onSelect={() => {}}
        />,
      );
      expect(screen.queryByText("see you at 6")).not.toBeInTheDocument();
    });

    it("does not render a preview when the flag is off, even if one is present", () => {
      featureFlagTestHooks.setCache({ room_list_message_preview: false });
      render(
        <RoomListItem
          room={makeRoomSummary({
            last_message_preview: {
              sender_id: "@alice:example.org",
              sender_display_name: "Alice",
              text: "see you at 6",
            },
          })}
          active={false}
          onSelect={() => {}}
        />,
      );
      expect(screen.queryByText("see you at 6", { exact: false })).not.toBeInTheDocument();
    });

    it("truncates a very long preview via CSS rather than growing the row", () => {
      const longText = "a".repeat(300);
      const { container } = renderWithPreview({
        last_message_preview: {
          sender_id: "@alice:example.org",
          sender_display_name: "Alice",
          text: longText,
        },
      });
      const preview = container.querySelector("p");
      expect(preview).not.toBeNull();
      expect(preview).toHaveClass("truncate");
      expect(preview).toHaveTextContent(longText);
    });
  });
});

describe("roomListItemPropsEqual", () => {
  const baseProps = { room, active: false, onSelect: () => {} };

  it("treats identical props as equal", () => {
    expect(roomListItemPropsEqual(baseProps, baseProps)).toBe(true);
  });

  it("treats a different active flag as unequal", () => {
    expect(roomListItemPropsEqual(baseProps, { ...baseProps, active: true })).toBe(false);
  });

  it("treats a different style reference as unequal, even with equivalent content", () => {
    const prev = { ...baseProps, style: { zIndex: 1 } };
    const next = { ...baseProps, style: { zIndex: 1 } };
    expect(roomListItemPropsEqual(prev, next)).toBe(false);
  });

  it("treats the same style reference as equal", () => {
    const style = { zIndex: 1 };
    expect(roomListItemPropsEqual({ ...baseProps, style }, { ...baseProps, style })).toBe(true);
  });

  it("treats a different dragHandleProps reference as unequal", () => {
    const prev = { ...baseProps, dragHandleProps: { "data-foo": 1 } };
    const next = { ...baseProps, dragHandleProps: { "data-foo": 1 } };
    expect(roomListItemPropsEqual(prev, next)).toBe(false);
  });

  it("short-circuits to equal when both room objects are the same reference", () => {
    expect(roomListItemPropsEqual(baseProps, { ...baseProps })).toBe(true);
  });

  it("treats a fresh room object with identical fields as equal", () => {
    const prev = { ...baseProps, room: { ...room } };
    const next = { ...baseProps, room: { ...room } };
    expect(roomListItemPropsEqual(prev, next)).toBe(true);
  });

  it.each([
    ["room_id", { room_id: "!different:localhost" }],
    ["name", { name: "Different name" }],
    ["avatar_path", { avatar_path: "/different.png" }],
    ["avatar_url", { avatar_url: "mxc://different" }],
    ["is_direct", { is_direct: !room.is_direct }],
    ["dm_peer_user_id", { dm_peer_user_id: "@different:localhost" }],
    ["is_marked_unread", { is_marked_unread: !room.is_marked_unread }],
    ["has_unread", { has_unread: !room.has_unread }],
    ["unread_count", { unread_count: room.unread_count + 1 }],
    ["unread_messages", { unread_messages: room.unread_messages + 1 }],
    ["is_muted", { is_muted: !room.is_muted }],
    ["is_favourite", { is_favourite: !room.is_favourite }],
    ["is_low_priority", { is_low_priority: !room.is_low_priority }],
  ] as const)("treats a changed room.%s as unequal", (_field, override) => {
    const prev = { ...baseProps, room: { ...room, ...override } };
    const next = { ...baseProps, room: { ...room } };
    expect(roomListItemPropsEqual(prev, next)).toBe(false);
  });

  it.each([
    ["sender_id", { sender_id: "@different:localhost" }],
    ["sender_display_name", { sender_display_name: "Different" }],
    ["text", { text: "different text" }],
  ] as const)("treats a changed last_message_preview.%s as unequal", (_field, override) => {
    const preview = { sender_id: "@a:localhost", sender_display_name: "A", text: "hi" };
    const prev = {
      ...baseProps,
      room: { ...room, last_message_preview: preview },
    };
    const next = {
      ...baseProps,
      room: { ...room, last_message_preview: { ...preview, ...override } },
    };
    expect(roomListItemPropsEqual(prev, next)).toBe(false);
  });

  it("treats null and present last_message_preview as unequal", () => {
    const prev = { ...baseProps, room: { ...room, last_message_preview: null } };
    const next = {
      ...baseProps,
      room: {
        ...room,
        last_message_preview: { sender_id: "@a:localhost", sender_display_name: null, text: "hi" },
      },
    };
    expect(roomListItemPropsEqual(prev, next)).toBe(false);
  });

  it("treats onRemoveFromSpace appearing or disappearing as unequal even with an unchanged room", () => {
    // Toggling the `space_rail_management` feature flag flips
    // `RoomList`'s `onRemoveFromSpace={flag ? handler : undefined}` for an
    // already-mounted row without changing any other compared field — the
    // comparator must not let a fresh callback's mere presence/absence slip
    // past as "equal" the way other callback props deliberately do.
    const withHandler = { ...baseProps, onRemoveFromSpace: vi.fn() };
    const withoutHandler = { ...baseProps, onRemoveFromSpace: undefined };
    expect(roomListItemPropsEqual(withoutHandler, withHandler)).toBe(false);
    expect(roomListItemPropsEqual(withHandler, withoutHandler)).toBe(false);
  });

  it("treats two different onRemoveFromSpace callbacks as equal when the target space is unchanged", () => {
    const prev = { ...baseProps, onRemoveFromSpace: vi.fn() };
    const next = { ...baseProps, onRemoveFromSpace: vi.fn() };
    expect(roomListItemPropsEqual(prev, next)).toBe(true);
  });

  it("treats a changed removeFromSpaceTargetId as unequal even though onRemoveFromSpace stays present", () => {
    // The same room can be visible under two different spaces — if the user
    // switches from one space's lobby to the other, `onRemoveFromSpace`
    // stays present in both renders (so the presence check alone wouldn't
    // catch this), but the closure now targets a different space. Without
    // comparing `removeFromSpaceTargetId`, the stale row could detach the
    // room from the wrong space when the action is selected.
    const prev = {
      ...baseProps,
      onRemoveFromSpace: vi.fn(),
      removeFromSpaceTargetId: "!space-a:localhost",
    };
    const next = {
      ...baseProps,
      onRemoveFromSpace: vi.fn(),
      removeFromSpaceTargetId: "!space-b:localhost",
    };
    expect(roomListItemPropsEqual(prev, next)).toBe(false);
  });
});
