import { atom } from "jotai";
import { describe, expect, it } from "vitest";
import { boundedAtomFamily } from "./boundedAtomFamily";

describe("boundedAtomFamily", () => {
  it("never tracks more than maxSize distinct keys", () => {
    const family = boundedAtomFamily((key: string) => atom(key), 2);

    family("a");
    family("b");
    expect(Array.from(family.getParams())).toEqual(["a", "b"]);

    family("c");
    expect(Array.from(family.getParams())).toHaveLength(2);
    expect(Array.from(family.getParams())).toContain("c");
    // "a" is the oldest of the three and should be the one evicted.
    expect(Array.from(family.getParams())).not.toContain("a");
  });

  it("does not evict a key that's re-requested (not brand new)", () => {
    const family = boundedAtomFamily((key: string) => atom(key), 2);

    family("a");
    family("b");
    // Re-requesting "a" doesn't grow the family, so there's nothing to evict.
    family("a");

    expect(Array.from(family.getParams())).toEqual(["a", "b"]);
  });

  it("keeps exactly maxSize entries across many sequential insertions", () => {
    const family = boundedAtomFamily((key: number) => atom(key), 3);

    for (let i = 0; i < 10; i++) {
      family(i);
      expect(Array.from(family.getParams()).length).toBeLessThanOrEqual(3);
    }

    // Only the most recently created keys should have survived.
    expect(Array.from(family.getParams())).toEqual([7, 8, 9]);
  });
});
