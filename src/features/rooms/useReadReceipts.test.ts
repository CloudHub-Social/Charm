import { createElement, type PropsWithChildren } from "react";
import { act, renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useReadReceipts } from "./useReadReceipts";
import type { ReceiptUpdate } from "@/lib/matrix";

let receiptsCallback: ((update: ReceiptUpdate) => void) | undefined;

vi.mock("@/lib/matrix", () => ({
  onReceiptsUpdate: vi.fn((callback: (update: ReceiptUpdate) => void) => {
    receiptsCallback = callback;
    return Promise.resolve(() => {});
  }),
}));

// `receiptsAtomFamily` is deliberately module-scoped (see useReadReceipts.ts)
// so cached receipts survive a real room switch — but that means Jotai's
// default store would leak state between these tests, since several of them
// reuse the same room id. Give each test its own store via a fresh Provider.
function renderWithStore<TProps, TResult>(hook: (props: TProps) => TResult, initialProps: TProps) {
  const store = createStore();
  const wrapper = ({ children }: PropsWithChildren) => createElement(Provider, { store }, children);
  return renderHook(hook, { initialProps, wrapper });
}

describe("useReadReceipts", () => {
  beforeEach(() => {
    receiptsCallback = undefined;
  });

  it("starts with no receipts", () => {
    const { result } = renderWithStore(
      () => useReadReceipts("!room:localhost", "@me:localhost"),
      undefined,
    );
    expect(result.current.receiptsByEvent.size).toBe(0);
  });

  it("groups the latest receipt per user under its event", () => {
    const { result } = renderWithStore(
      () => useReadReceipts("!room:localhost", "@me:localhost"),
      undefined,
    );

    act(() => {
      receiptsCallback?.({
        room_id: "!room:localhost",
        receipts: [
          { event_id: "$a", user_id: "@alice:localhost", receipt_type: "read", ts_ms: 100 },
        ],
      });
    });

    expect(result.current.receiptsByEvent.get("$a")).toEqual(["@alice:localhost"]);
  });

  it("moves a user's avatar when a later receipt supersedes an earlier one", () => {
    const { result } = renderWithStore(
      () => useReadReceipts("!room:localhost", "@me:localhost"),
      undefined,
    );

    act(() => {
      receiptsCallback?.({
        room_id: "!room:localhost",
        receipts: [
          { event_id: "$a", user_id: "@alice:localhost", receipt_type: "read", ts_ms: 100 },
        ],
      });
    });
    act(() => {
      receiptsCallback?.({
        room_id: "!room:localhost",
        receipts: [
          { event_id: "$b", user_id: "@alice:localhost", receipt_type: "read", ts_ms: 200 },
        ],
      });
    });

    expect(result.current.receiptsByEvent.get("$a")).toBeUndefined();
    expect(result.current.receiptsByEvent.get("$b")).toEqual(["@alice:localhost"]);
  });

  it("ignores receipts for a different room", () => {
    const { result } = renderWithStore(
      () => useReadReceipts("!room:localhost", "@me:localhost"),
      undefined,
    );

    act(() => {
      receiptsCallback?.({
        room_id: "!other:localhost",
        receipts: [
          { event_id: "$a", user_id: "@alice:localhost", receipt_type: "read", ts_ms: 100 },
        ],
      });
    });

    expect(result.current.receiptsByEvent.size).toBe(0);
  });

  it("filters out the current user's own receipt", () => {
    const { result } = renderWithStore(
      () => useReadReceipts("!room:localhost", "@me:localhost"),
      undefined,
    );

    act(() => {
      receiptsCallback?.({
        room_id: "!room:localhost",
        receipts: [{ event_id: "$a", user_id: "@me:localhost", receipt_type: "read", ts_ms: 100 }],
      });
    });

    expect(result.current.receiptsByEvent.size).toBe(0);
  });

  it("shows an empty view for a different, never-visited room", () => {
    const { result, rerender } = renderWithStore(
      ({ roomId }: { roomId: string }) => useReadReceipts(roomId, "@me:localhost"),
      { roomId: "!room:localhost" },
    );

    act(() => {
      receiptsCallback?.({
        room_id: "!room:localhost",
        receipts: [
          { event_id: "$a", user_id: "@alice:localhost", receipt_type: "read", ts_ms: 100 },
        ],
      });
    });
    expect(result.current.receiptsByEvent.size).toBe(1);

    rerender({ roomId: "!other:localhost" });
    expect(result.current.receiptsByEvent.size).toBe(0);
  });

  it("keeps a room's cached receipts when switching away and back", () => {
    // `m.receipt` updates are push-only deltas with no refetch path — if
    // switching away wiped the cache, revisiting a room would show no
    // avatars until a new receipt happened to arrive.
    const { result, rerender } = renderWithStore(
      ({ roomId }: { roomId: string }) => useReadReceipts(roomId, "@me:localhost"),
      { roomId: "!room:localhost" },
    );

    act(() => {
      receiptsCallback?.({
        room_id: "!room:localhost",
        receipts: [
          { event_id: "$a", user_id: "@alice:localhost", receipt_type: "read", ts_ms: 100 },
        ],
      });
    });
    expect(result.current.receiptsByEvent.get("$a")).toEqual(["@alice:localhost"]);

    rerender({ roomId: "!other:localhost" });
    expect(result.current.receiptsByEvent.size).toBe(0);

    rerender({ roomId: "!room:localhost" });
    expect(result.current.receiptsByEvent.get("$a")).toEqual(["@alice:localhost"]);
  });
});
