import { describe, expect, it } from "vitest";
import { useRoomDraft } from "./useRoomDraft";

describe("useRoomDraft", () => {
  it("returns an empty draft for a room that's never been set", () => {
    const draft = useRoomDraft("!never-seen:example.org");
    expect(draft.getDraft()).toBe("");
  });

  it("round-trips a draft for the same room id", () => {
    const draft = useRoomDraft("!a:example.org");
    draft.setDraft("<p>hello</p>");
    expect(draft.getDraft()).toBe("<p>hello</p>");
  });

  it("keeps drafts isolated per room id", () => {
    useRoomDraft("!room-a:example.org").setDraft("draft a");
    useRoomDraft("!room-b:example.org").setDraft("draft b");
    expect(useRoomDraft("!room-a:example.org").getDraft()).toBe("draft a");
    expect(useRoomDraft("!room-b:example.org").getDraft()).toBe("draft b");
  });
});
