import { describe, expect, it } from "vitest";
import { computeManualOrder, groupRoomsIntoSections } from "./roomSections";
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
