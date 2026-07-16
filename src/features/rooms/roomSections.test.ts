import { describe, expect, it } from "vitest";
import {
  computeManualOrder,
  groupRoomsIntoSections,
  planManualReorder,
  targetIndexFromMeasuredHeights,
} from "./roomSections";
import { makeRoomSummary } from "./testFixtures";

describe("groupRoomsIntoSections", () => {
  it("puts favourites in their own section ahead of everything else", () => {
    const fav = makeRoomSummary({ room_id: "!fav:localhost", is_favourite: true });
    const plain = makeRoomSummary({ room_id: "!plain:localhost" });
    const sections = groupRoomsIntoSections([fav, plain]);
    expect(sections.favourites).toEqual([fav]);
    expect(sections.rooms).toEqual([plain]);
  });

  it("puts low-priority rooms in their own section", () => {
    const low = makeRoomSummary({ room_id: "!low:localhost", is_low_priority: true });
    const sections = groupRoomsIntoSections([low]);
    expect(sections.lowPriority).toEqual([low]);
    expect(sections.rooms).toEqual([]);
  });

  it("favourite wins over low-priority for section placement", () => {
    const room = makeRoomSummary({ is_favourite: true, is_low_priority: true });
    const sections = groupRoomsIntoSections([room]);
    expect(sections.favourites).toEqual([room]);
    expect(sections.lowPriority).toEqual([]);
  });

  it("groups rooms under the space that lists them as a child", () => {
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true, name: "Team" });
    const child = makeRoomSummary({
      room_id: "!child:localhost",
      parent_space_ids: ["!space:localhost"],
    });
    const ungrouped = makeRoomSummary({ room_id: "!ungrouped:localhost" });
    const sections = groupRoomsIntoSections([space, child, ungrouped]);

    expect(sections.spaceGroups).toEqual([{ space, rooms: [child] }]);
    expect(sections.rooms).toEqual([ungrouped]);
  });

  it("does not double-count a favourited room that also belongs to a space", () => {
    const space = makeRoomSummary({ room_id: "!space:localhost", is_space: true });
    const child = makeRoomSummary({
      room_id: "!child:localhost",
      is_favourite: true,
      parent_space_ids: ["!space:localhost"],
    });
    const sections = groupRoomsIntoSections([space, child]);

    expect(sections.favourites).toEqual([child]);
    expect(sections.spaceGroups).toEqual([]);
  });
});

describe("computeManualOrder", () => {
  it("returns the midpoint between two ordered neighbours", () => {
    const before = makeRoomSummary({ room_id: "a", manual_order: 1 });
    const after = makeRoomSummary({ room_id: "b", manual_order: 3 });
    expect(computeManualOrder([before, after], 1)).toBe(2);
  });

  it("steps up from a preceding neighbour with no following neighbour", () => {
    const before = makeRoomSummary({ room_id: "a", manual_order: 5 });
    expect(computeManualOrder([before], 1)).toBe(6);
  });

  it("steps down from a following neighbour with no preceding neighbour", () => {
    const after = makeRoomSummary({ room_id: "a", manual_order: 5 });
    expect(computeManualOrder([after], 0)).toBe(4);
  });

  it("falls back to array position when neither neighbour has a manual order, so the first drag in a still-alphabetical section anchors between its flanking siblings instead of jumping to the top", () => {
    const a = makeRoomSummary({ room_id: "a", manual_order: null });
    const b = makeRoomSummary({ room_id: "b", manual_order: null });
    const c = makeRoomSummary({ room_id: "c", manual_order: null });
    // Dropping between index 0 (a) and index 1 (b, c unaffected as "after")
    // should land between their positions (0 and 1), not at a bare 0 that
    // would sort ahead of every still-null sibling.
    expect(computeManualOrder([a, b, c], 1)).toBe(0.5);
  });

  it("falls back to array position for a null neighbour even next to a real order, rather than treating it as unconstrained", () => {
    const ordered = makeRoomSummary({ room_id: "a", manual_order: 10 });
    const unordered = makeRoomSummary({ room_id: "b", manual_order: null });
    // `unordered` falls back to its own index (1), so the midpoint is
    // between 10 and 1 — not simply "10 + 1" as if `unordered` had no
    // position at all.
    expect(computeManualOrder([ordered, unordered], 1)).toBe(5.5);
  });
});

describe("planManualReorder", () => {
  it("seeds sequential orders for the whole section when it's still fully alphabetical, so the dragged room lands at the drop position instead of jumping ahead of every null sibling", () => {
    const a = makeRoomSummary({ room_id: "a", manual_order: null });
    const b = makeRoomSummary({ room_id: "b", manual_order: null });
    const c = makeRoomSummary({ room_id: "c", manual_order: null });
    // Drag `a` to land between `b` and `c` (target index 1, excluding `a`).
    const plan = planManualReorder([a, b, c], "a", 1);
    expect(plan).toEqual([
      { room_id: "b", order: 0 },
      { room_id: "a", order: 1 },
      { room_id: "c", order: 2 },
    ]);
  });

  it("only updates the dragged room with a midpoint once the section already has a real manual order", () => {
    const a = makeRoomSummary({ room_id: "a", manual_order: 1 });
    const b = makeRoomSummary({ room_id: "b", manual_order: 3 });
    const dragged = makeRoomSummary({ room_id: "c", manual_order: null });
    const plan = planManualReorder([a, dragged, b], "c", 1);
    expect(plan).toEqual([{ room_id: "c", order: 2 }]);
  });

  it("returns no updates when the dragged room isn't found in the section", () => {
    const a = makeRoomSummary({ room_id: "a" });
    expect(planManualReorder([a], "missing", 0)).toEqual([]);
  });
});

describe("targetIndexFromMeasuredHeights", () => {
  it("falls back to the default row height and rounds like a fixed-height drag when nothing has been measured", () => {
    const rooms = [
      makeRoomSummary({ room_id: "a" }),
      makeRoomSummary({ room_id: "b" }),
      makeRoomSummary({ room_id: "c" }),
    ];
    // Default row height is 46px — a 50px downward drag from index 0 should
    // land on index 1 (past the first row's midpoint).
    expect(targetIndexFromMeasuredHeights(rooms, 0, 50, new Map())).toBe(1);
    // 20px isn't past the midpoint of a 46px row.
    expect(targetIndexFromMeasuredHeights(rooms, 0, 20, new Map())).toBe(0);
  });

  it("uses each row's own measured height instead of a fixed row height", () => {
    const rooms = [
      makeRoomSummary({ room_id: "a" }),
      makeRoomSummary({ room_id: "b" }),
      makeRoomSummary({ room_id: "c" }),
    ];
    // Row "a" (a preview row) is 70px tall — a fixed-46px assumption would
    // wrongly cross into index 1 well before 70px of drag.
    const heights = new Map([["a", 70]]);
    expect(targetIndexFromMeasuredHeights(rooms, 0, 34, heights)).toBe(0);
    expect(targetIndexFromMeasuredHeights(rooms, 0, 36, heights)).toBe(1);
  });

  it("walks upward through measured heights for an upward drag", () => {
    const rooms = [
      makeRoomSummary({ room_id: "a" }),
      makeRoomSummary({ room_id: "b" }),
      makeRoomSummary({ room_id: "c" }),
    ];
    const heights = new Map([["b", 70]]);
    expect(targetIndexFromMeasuredHeights(rooms, 2, -34, heights)).toBe(2);
    expect(targetIndexFromMeasuredHeights(rooms, 2, -36, heights)).toBe(1);
  });

  it("clamps at the section boundaries instead of walking past them", () => {
    const rooms = [makeRoomSummary({ room_id: "a" }), makeRoomSummary({ room_id: "b" })];
    expect(targetIndexFromMeasuredHeights(rooms, 0, 10_000, new Map())).toBe(1);
    expect(targetIndexFromMeasuredHeights(rooms, 1, -10_000, new Map())).toBe(0);
  });

  it("returns the same index for zero movement", () => {
    const rooms = [makeRoomSummary({ room_id: "a" }), makeRoomSummary({ room_id: "b" })];
    expect(targetIndexFromMeasuredHeights(rooms, 0, 0, new Map())).toBe(0);
  });
});
