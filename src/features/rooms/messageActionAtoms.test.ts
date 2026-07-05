import { createStore } from "jotai";
import { describe, expect, it } from "vitest";
import { activeReplyTargetAtomFamily, editingEventIdAtomFamily } from "./messageActionAtoms";

describe("messageActionAtoms", () => {
  it("defaults to no active reply target for a room", () => {
    const store = createStore();
    expect(store.get(activeReplyTargetAtomFamily("!room:localhost"))).toBeNull();
  });

  it("setting a reply target puts that room's atom into reply mode", () => {
    const store = createStore();
    const atom = activeReplyTargetAtomFamily("!room:localhost");

    store.set(atom, { event_id: "$abc", sender: "@alice:localhost", preview: "hello" });

    expect(store.get(atom)).toEqual({
      event_id: "$abc",
      sender: "@alice:localhost",
      preview: "hello",
    });
  });

  it("keeps reply targets isolated per room", () => {
    const store = createStore();
    const roomA = activeReplyTargetAtomFamily("!a:localhost");
    const roomB = activeReplyTargetAtomFamily("!b:localhost");

    store.set(roomA, { event_id: "$a", sender: "@alice:localhost", preview: "in room a" });

    expect(store.get(roomA)).not.toBeNull();
    expect(store.get(roomB)).toBeNull();
  });

  it("clearing the reply target returns it to null", () => {
    const store = createStore();
    const atom = activeReplyTargetAtomFamily("!room:localhost");
    store.set(atom, { event_id: "$abc", sender: "@alice:localhost", preview: "hello" });

    store.set(atom, null);

    expect(store.get(atom)).toBeNull();
  });

  it("defaults to no editing event id for a room", () => {
    const store = createStore();
    expect(store.get(editingEventIdAtomFamily("!room:localhost"))).toBeNull();
  });

  it("setting an editing event id puts that room's atom into edit mode", () => {
    const store = createStore();
    const atom = editingEventIdAtomFamily("!room:localhost");

    store.set(atom, "$abc");

    expect(store.get(atom)).toBe("$abc");
  });
});
