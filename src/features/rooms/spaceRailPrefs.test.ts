import { describe, expect, it } from "vitest";
import { moveSpaceInOrder, orderSpaceIds } from "./spaceRailPrefs";

describe("orderSpaceIds", () => {
  it("sorts explicitly ordered ids first, natural-order ids after", () => {
    expect(orderSpaceIds(["a", "b", "c"], ["c", "a"])).toEqual(["c", "a", "b"]);
  });

  it("preserves natural order among ids with no explicit rank", () => {
    expect(orderSpaceIds(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
  });
});

describe("moveSpaceInOrder", () => {
  it("returns the same order when the space isn't in the visible list", () => {
    expect(moveSpaceInOrder(["a", "b"], [], "z", "up")).toEqual([]);
  });

  it("returns the same order when already at the boundary", () => {
    expect(moveSpaceInOrder(["a", "b"], [], "a", "up")).toEqual([]);
    expect(moveSpaceInOrder(["a", "b"], [], "b", "down")).toEqual([]);
  });

  it("moves an unordered space above its unordered neighbor without baking in the rest", () => {
    const result = moveSpaceInOrder(["a", "b", "c"], [], "b", "up");
    // Only the two swapped ids become explicit — "c" stays absent, still
    // falling back to natural order for anything not touched by this move.
    expect(result).toEqual(["b", "a"]);
  });

  it("moves an unordered space below its unordered neighbor without baking in the rest", () => {
    const result = moveSpaceInOrder(["a", "b", "c"], [], "a", "down");
    expect(result).toEqual(["b", "a"]);
  });

  it("keeps unrelated pre-existing explicit entries untouched", () => {
    // "d" is already pinned to the top by a prior move; moving "b" past "a"
    // must not disturb "d"'s position or drag in "c".
    const result = moveSpaceInOrder(["a", "b", "c", "d"], ["d"], "b", "up");
    expect(result).toEqual(["d", "b", "a"]);
  });

  it("repeated moves stay sparse rather than re-materializing the full list", () => {
    let order: string[] = [];
    order = moveSpaceInOrder(["a", "b", "c", "d", "e"], order, "b", "up");
    order = moveSpaceInOrder(["a", "b", "c", "d", "e"], order, "d", "up");
    // Two moves touching at most 4 distinct ids should never balloon into
    // all 5 — "e" was never touched and must stay absent (natural order).
    expect(order).not.toContain("e");
    expect(new Set(order).size).toBeLessThanOrEqual(4);
  });

  it("a newly joined space still interleaves naturally after an earlier move", () => {
    // Simulates: user reorders b above a while only a/b/c exist, then a new
    // space "d" joins. "d" was never explicitly ordered, so it must still
    // fall back to its natural (join-order) position relative to "c" rather
    // than being forced to the very end behind every previously-seen space.
    const afterFirstMove = moveSpaceInOrder(["a", "b", "c"], [], "b", "up");
    const visibleWithNewSpace = orderSpaceIds(["a", "b", "c", "d"], afterFirstMove);
    expect(visibleWithNewSpace).toEqual(["b", "a", "c", "d"]);
  });
});
