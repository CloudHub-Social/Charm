import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useReadReceipts } from "./useReadReceipts";
import type { ReceiptUpdate } from "@/lib/matrix";

let receiptsCallback: ((update: ReceiptUpdate) => void) | undefined;

vi.mock("@/lib/matrix", () => ({
  onReceiptsUpdate: vi.fn((callback: (update: ReceiptUpdate) => void) => {
    receiptsCallback = callback;
    return Promise.resolve(() => {});
  }),
}));

describe("useReadReceipts", () => {
  it("starts with no receipts", () => {
    const { result } = renderHook(() => useReadReceipts("!room:localhost", "@me:localhost"));
    expect(result.current.receiptsByEvent.size).toBe(0);
  });

  it("groups the latest receipt per user under its event", () => {
    const { result } = renderHook(() => useReadReceipts("!room:localhost", "@me:localhost"));

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
    const { result } = renderHook(() => useReadReceipts("!room:localhost", "@me:localhost"));

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
    const { result } = renderHook(() => useReadReceipts("!room:localhost", "@me:localhost"));

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
    const { result } = renderHook(() => useReadReceipts("!room:localhost", "@me:localhost"));

    act(() => {
      receiptsCallback?.({
        room_id: "!room:localhost",
        receipts: [{ event_id: "$a", user_id: "@me:localhost", receipt_type: "read", ts_ms: 100 }],
      });
    });

    expect(result.current.receiptsByEvent.size).toBe(0);
  });

  it("clears receipts when switching rooms", () => {
    const { result, rerender } = renderHook(
      ({ roomId }: { roomId: string }) => useReadReceipts(roomId, "@me:localhost"),
      { initialProps: { roomId: "!room:localhost" } },
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
});
