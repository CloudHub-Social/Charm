import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeMessageSummary } from "./testFixtures";
import { useMessageActionController } from "./useMessageActionController";

const mocks = vi.hoisted(() => ({
  useFlag: vi.fn(() => true),
  isWebBuild: vi.fn(() => false),
  handleDelete: vi.fn(async () => true),
  handleReport: vi.fn(async () => true),
  handleReply: vi.fn(),
  handleEdit: vi.fn(),
  handleToggleReaction: vi.fn(),
  handleResend: vi.fn(),
  handleDiscard: vi.fn(),
  handlePin: vi.fn(),
  handleUnpin: vi.fn(),
  handleBookmark: vi.fn(),
  handleUnbookmark: vi.fn(),
}));

vi.mock("@/featureFlags", () => ({ useFlag: () => mocks.useFlag() }));
vi.mock("@/lib/platform", () => ({ isWebBuild: () => mocks.isWebBuild() }));
vi.mock("./useMessageActions", () => ({
  useMessageActions: () => ({
    ...mocks,
    bookmarkedEventIds: new Set(["$bookmarked"]),
  }),
}));

const message = makeMessageSummary({
  event_id: "$event:example.org",
  sender: "@alice:example.org",
  body: "hello",
});

describe("useMessageActionController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useFlag.mockReturnValue(true);
    mocks.isWebBuild.mockReturnValue(false);
  });

  it("scopes dialog targets to the room that opened them", () => {
    const { result, rerender } = renderHook(
      ({ roomId }) =>
        useMessageActionController({
          roomId,
          currentUserId: "@me:example.org",
          setReplyTarget: vi.fn(),
          setEditingEventId: vi.fn(),
        }),
      { initialProps: { roomId: "!one:example.org" } },
    );

    act(() => result.current.rowActions(message).onViewSource?.());
    expect(result.current.visibleDialogTarget).toEqual({
      kind: "source",
      roomId: "!one:example.org",
      eventId: "$event:example.org",
    });

    rerender({ roomId: "!two:example.org" });
    expect(result.current.visibleDialogTarget).toBeNull();
  });

  it("replaces long-press action handles synchronously on a room switch", () => {
    const { result, rerender } = renderHook(
      ({ roomId }) =>
        useMessageActionController({
          roomId,
          currentUserId: "@me:example.org",
          setReplyTarget: vi.fn(),
          setEditingEventId: vi.fn(),
        }),
      { initialProps: { roomId: "!one:example.org" } },
    );
    const handle = { startLongPress: vi.fn(), cancelLongPress: vi.fn() };
    act(() => result.current.registerActionsRef("$same-key", handle));
    expect(result.current.getActionsHandle("$same-key")).toBe(handle);

    rerender({ roomId: "!two:example.org" });
    expect(result.current.getActionsHandle("$same-key")).toBeUndefined();
  });

  it("rejects confirmations whose target no longer matches the active room", async () => {
    const { result } = renderHook(() =>
      useMessageActionController({
        roomId: "!current:example.org",
        currentUserId: "@me:example.org",
        setReplyTarget: vi.fn(),
        setEditingEventId: vi.fn(),
      }),
    );

    await expect(
      result.current.confirmDialog(
        { kind: "delete", roomId: "!stale:example.org", eventId: "$event:example.org" },
        "reason",
      ),
    ).resolves.toBe(false);
    expect(mocks.handleDelete).not.toHaveBeenCalled();
  });

  it("keeps parity-disabled deletion immediate and hides parity-only actions", () => {
    mocks.useFlag.mockReturnValue(false);
    const { result } = renderHook(() =>
      useMessageActionController({
        roomId: "!room:example.org",
        currentUserId: "@me:example.org",
        setReplyTarget: vi.fn(),
        setEditingEventId: vi.fn(),
      }),
    );

    const rowActions = result.current.rowActions(message);
    act(() => rowActions.onDelete());
    expect(mocks.handleDelete).toHaveBeenCalledWith("$event:example.org");
    expect(rowActions.onForward).toBeUndefined();
    expect(result.current.visibleDialogTarget).toBeNull();
  });

  it("omits account-local bookmark actions on the web build", () => {
    mocks.isWebBuild.mockReturnValue(true);
    const { result } = renderHook(() =>
      useMessageActionController({
        roomId: "!room:example.org",
        currentUserId: "@me:example.org",
        setReplyTarget: vi.fn(),
        setEditingEventId: vi.fn(),
      }),
    );

    const rowActions = result.current.rowActions(message);
    expect(rowActions.onBookmark).toBeUndefined();
    expect(rowActions.onUnbookmark).toBeUndefined();
    expect(rowActions.isBookmarked).toBe(false);
  });
});
