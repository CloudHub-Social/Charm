import { describe, expect, it } from "vitest";
import { pinnedMessagesQueryKey } from "./usePinnedMessages";

describe("pinnedMessagesQueryKey", () => {
  // Review fix: Matrix event ids are opaque strings with no guarantee
  // against containing a comma — a `.join(",")`-based key could collide
  // between two genuinely different pinned-id lists (one 2-item list vs a
  // different 1-item list whose sole id happens to contain a comma).
  // Passing the array itself (React Query keys are matched by deep
  // equality) avoids the ambiguity entirely.
  it("produces distinct keys for id lists that would collide if comma-joined", () => {
    const keyA = pinnedMessagesQueryKey("!room:localhost", ["$a", "$b"]);
    const keyB = pinnedMessagesQueryKey("!room:localhost", ["$a,$b"]);

    expect(keyA).not.toEqual(keyB);
  });

  it("produces the same key for the same room and id list", () => {
    const keyA = pinnedMessagesQueryKey("!room:localhost", ["$a", "$b"]);
    const keyB = pinnedMessagesQueryKey("!room:localhost", ["$a", "$b"]);

    expect(keyA).toEqual(keyB);
  });
});
