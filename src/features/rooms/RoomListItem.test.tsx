import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomListItem } from "./RoomListItem";
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
