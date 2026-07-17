import { createStore } from "jotai";
import { describe, expect, it } from "vitest";
import { presenceAtomFamily, presenceUpdateAtom } from "./presenceAtoms";
import type { PresenceUpdate } from "@/lib/matrix";

describe("presenceUpdateAtom", () => {
  it("resolves to the same per-user atom presenceAtomFamily returns for that user_id", () => {
    const store = createStore();
    const update: PresenceUpdate = {
      user_id: "@alice:localhost",
      presence: "online",
      status_msg: null,
      last_active_ago_ms: null,
    };

    store.set(presenceUpdateAtom(update), update);

    expect(store.get(presenceAtomFamily("@alice:localhost"))).toEqual(update);
  });
});
