import { beforeEach, describe, expect, it } from "vitest";
import {
  clearQuickSwitcherRecents,
  readQuickSwitcherRecents,
  reconcileQuickSwitcherRecents,
  recordQuickSwitcherRecent,
} from "./quickSwitcherRecents";

describe("quickSwitcherRecents", () => {
  beforeEach(() => localStorage.clear());

  it("keeps account histories isolated and most-recent-first", () => {
    recordQuickSwitcherRecent("@alice:example.org", "!one:example.org");
    recordQuickSwitcherRecent("@alice:example.org", "!two:example.org");
    recordQuickSwitcherRecent("@bob:example.org", "!bob:example.org");

    expect(readQuickSwitcherRecents("@alice:example.org")).toEqual([
      "!two:example.org",
      "!one:example.org",
    ]);
    expect(readQuickSwitcherRecents("@bob:example.org")).toEqual(["!bob:example.org"]);
  });

  it("deduplicates, caps, and lazily removes stale room ids", () => {
    for (let index = 0; index < 25; index += 1) {
      recordQuickSwitcherRecent("@alice:example.org", `!${index}:example.org`);
    }
    recordQuickSwitcherRecent("@alice:example.org", "!24:example.org");

    const reconciled = reconcileQuickSwitcherRecents(
      "@alice:example.org",
      new Set(["!24:example.org", "!23:example.org"]),
    );
    expect(reconciled).toEqual(["!24:example.org", "!23:example.org"]);
    expect(readQuickSwitcherRecents("@alice:example.org")).toEqual(reconciled);
  });

  it("clears only the signed-in account", () => {
    recordQuickSwitcherRecent("@alice:example.org", "!one:example.org");
    recordQuickSwitcherRecent("@bob:example.org", "!two:example.org");
    clearQuickSwitcherRecents("@alice:example.org");

    expect(readQuickSwitcherRecents("@alice:example.org")).toEqual([]);
    expect(readQuickSwitcherRecents("@bob:example.org")).toEqual(["!two:example.org"]);
  });
});
