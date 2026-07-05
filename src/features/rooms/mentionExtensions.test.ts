import { describe, expect, it } from "vitest";
import { RoomMention, UserMention } from "./mentionExtensions";

/** Minimal stand-in for the ProseMirror node `renderHTML` receives. */
function fakeNode(attrs: Record<string, unknown>) {
  return { attrs } as never;
}

describe("UserMention", () => {
  it("renders a matrix.to anchor for the mentioned user id", () => {
    const renderHTML = UserMention.config.renderHTML!;
    const [tag, attrs, text] = renderHTML.call(undefined as never, {
      node: fakeNode({ id: "@alice:example.org", label: "Alice" }),
      HTMLAttributes: {},
    }) as [string, Record<string, string>, string];

    expect(tag).toBe("a");
    expect(attrs.href).toBe("https://matrix.to/#/@alice:example.org");
    expect(attrs["data-mx-pill"]).toBe("true");
    expect(text).toBe("@Alice");
  });

  it("falls back to the bare id when there's no display name", () => {
    const renderHTML = UserMention.config.renderHTML!;
    const [, , text] = renderHTML.call(undefined as never, {
      node: fakeNode({ id: "@bob:example.org", label: null }),
      HTMLAttributes: {},
    }) as [string, Record<string, string>, string];

    expect(text).toBe("@@bob:example.org");
  });

  it("configures its trigger character as @", () => {
    expect(UserMention.options.suggestion.char).toBe("@");
  });
});

describe("RoomMention", () => {
  it("renders a matrix.to anchor for the mentioned room", () => {
    const renderHTML = RoomMention.config.renderHTML!;
    const [tag, attrs, text] = renderHTML.call(undefined as never, {
      node: fakeNode({ id: "!abc:example.org", label: "General" }),
      HTMLAttributes: {},
    }) as [string, Record<string, string>, string];

    expect(tag).toBe("a");
    expect(attrs.href).toBe("https://matrix.to/#/!abc:example.org");
    expect(text).toBe("#General");
  });

  it("configures its trigger character as #", () => {
    expect(RoomMention.options.suggestion.char).toBe("#");
  });
});
