import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MatrixModule from "@/lib/matrix";
import type { RoomMessageSummary } from "@/lib/matrix";
import { makeRoomSummary } from "./testFixtures";
import { useTimelineViewport } from "./useTimelineViewport";

const loadTimelineAroundEvent = vi.fn();
vi.mock("@/lib/matrix", async (importOriginal) => ({
  ...(await importOriginal<typeof MatrixModule>()),
  loadTimelineAroundEvent: (...args: unknown[]) => loadTimelineAroundEvent(...args),
}));

function message(
  eventId: string,
  sender = "@other:localhost",
  timestampMs = 1,
): RoomMessageSummary {
  return {
    event_id: eventId,
    sender,
    sender_display_name: null,
    sender_avatar_url: null,
    sender_avatar_path: null,
    body: eventId,
    formatted_body: null,
    timestamp_ms: timestampMs,
    edited: false,
    redacted: false,
    reactions: [],
    in_reply_to: null,
    transaction_id: null,
    send_state: { state: "sent" },
    media: null,
    is_undecrypted: false,
  };
}

function props(overrides: Partial<Parameters<typeof useTimelineViewport>[0]> = {}) {
  return {
    room: makeRoomSummary({ unread_messages: 1 }),
    currentUserId: "@me:localhost",
    messages: [message("$initial")],
    loading: true,
    loadingMore: false,
    hasMore: false,
    paginationError: false,
    prependedCount: 0,
    awaitingEmptyPagePagination: false,
    jumpToEventId: null,
    handleAtBottomStateChange: vi.fn(),
    resetToLive: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("useTimelineViewport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadTimelineAroundEvent.mockResolvedValue({
      found: false,
      installed_focused_view: false,
    });
  });

  it("freezes the unread boundary and counts only arrivals after the initial load", () => {
    const initialProps = props();
    const { result, rerender } = renderHook((currentProps) => useTimelineViewport(currentProps), {
      initialProps,
    });

    rerender({ ...initialProps, loading: false });
    expect(result.current.unreadStartIdx).toBe(0);
    expect(result.current.newMessageKeys).toEqual(new Set());

    act(() => result.current.handleVirtuosoAtBottomStateChange(false));
    rerender({
      ...initialProps,
      loading: false,
      messages: [...initialProps.messages, message("$new", "@other:localhost", 2)],
    });

    expect(result.current.newMessageKeys).toEqual(new Set(["$new"]));
    expect(result.current.newMessageCount).toBe(1);
    expect(result.current.unreadStartIdx).toBe(0);
  });

  it("uses one reconciliation path when an own send returns to present", () => {
    const initialProps = props();
    const { result } = renderHook(() => useTimelineViewport(initialProps));
    const scrollToIndex = vi.fn();
    result.current.virtuosoRef.current = { scrollToIndex } as never;

    act(() => result.current.scrollToPresentAfterOwnSend());

    expect(scrollToIndex).toHaveBeenCalledWith({ index: "LAST", align: "end" });
    expect(initialProps.handleAtBottomStateChange).toHaveBeenCalledWith(true);
    expect(result.current.atBottom).toBe(true);
  });

  it("drops viewport and focused-view state synchronously on a room switch", () => {
    const initialProps = props();
    const { result, rerender } = renderHook((currentProps) => useTimelineViewport(currentProps), {
      initialProps,
    });
    act(() => result.current.handleVirtuosoAtBottomStateChange(false));
    expect(result.current.atBottom).toBe(false);

    rerender({
      ...initialProps,
      room: makeRoomSummary({ room_id: "!other:localhost" }),
      messages: [],
    });

    expect(result.current.atBottom).toBe(true);
    expect(result.current.newMessageCount).toBe(0);
    expect(result.current.hasFocusedView).toBe(false);
  });
});
