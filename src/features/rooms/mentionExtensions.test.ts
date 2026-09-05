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
    expect(attrs.href).toBe("https://matrix.to/#/%40alice%3Aexample.org");
    expect(attrs["data-mx-pill"]).toBe("true");
    expect(text).toBe("@Alice");
  });

  it("falls back to the bare id when there's no display name", () => {
    const renderHTML = UserMention.config.renderHTML!;
    const [, , text] = renderHTML.call(undefined as never, {
      node: fakeNode({ id: "@bob:example.org", label: null }),
      HTMLAttributes: {},
    }) as [string, Record<string, string>, string];

    expect(text).toBe("@bob:example.org");
  });

  it("configures its trigger character as @", () => {
    expect(UserMention.options.suggestion.char).toBe("@");
  });

  it("renders the real user id (not the display label) for plain-text getText()", () => {
    const renderText = UserMention.config.renderText!;
    const text = renderText.call(
      undefined as never,
      {
        node: fakeNode({ id: "@alice:example.org", label: "Alice" }),
        options: {},
      } as never,
    );
    expect(text).toBe("@alice:example.org");
  });

  it("parses its own rendered anchor back into a mention node's attrs", () => {
    const anchor = document.createElement("a");
    anchor.setAttribute(
      "href",
      "https://matrix.to/#/%40alice%3Aexample.org?action=chat&via=example.org",
    );
    anchor.setAttribute("data-mx-pill", "true");
    anchor.textContent = "@Alice";

    const rules = UserMention.config.parseHTML!.call({} as never)!;
    const attrs = rules[0]!.getAttrs!(anchor);

    expect(attrs).toEqual({ id: "@alice:example.org", label: "Alice" });
  });

  it("does not parse a room-mention anchor as a user mention", () => {
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "https://matrix.to/#/!room:example.org");
    anchor.setAttribute("data-mx-pill", "true");
    anchor.textContent = "#General";

    const rules = UserMention.config.parseHTML!.call({} as never)!;
    const attrs = rules[0]!.getAttrs!(anchor);

    expect(attrs).toBe(false);
  });

  it("leaves a malformed user pill as an ordinary anchor", () => {
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "https://matrix.to/#/%40not-a-user");
    anchor.setAttribute("data-mx-pill", "true");
    anchor.textContent = "@not-a-user";

    const rules = UserMention.config.parseHTML!.call({} as never)!;

    expect(rules[0]!.getAttrs!(anchor)).toBe(false);
  });

  it("preserves a question mark in a legacy raw user-id fragment", () => {
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "https://matrix.to/#/@alice?work:example.org");
    anchor.setAttribute("data-mx-pill", "true");
    anchor.textContent = "@Alice";
    const rules = UserMention.config.parseHTML!.call({} as never)!;

    expect(rules[0]!.getAttrs!(anchor)).toEqual({ id: "@alice?work:example.org", label: "Alice" });
  });

  it("strips permalink parameters after a legacy raw user id containing a question mark", () => {
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "https://matrix.to/#/@alice?work:example.org?action=chat");
    anchor.setAttribute("data-mx-pill", "true");
    anchor.textContent = "@Alice";
    const rules = UserMention.config.parseHTML!.call({} as never)!;

    expect(rules[0]!.getAttrs!(anchor)).toEqual({ id: "@alice?work:example.org", label: "Alice" });
  });

  it.each([
    "https://matrix.to/#/@alice:example.org/path",
    "https://matrix.to/#/@alice:example.org:",
    "https://matrix.to/#/@alice:example.org:99999",
    "https://matrix.to/#/%40alice%3Aexample.org%20",
    "https://matrix.to/#/%40alice%3Aexample%09.org",
  ])("rejects a pill whose server name is malformed: %s", (href) => {
    const anchor = document.createElement("a");
    anchor.setAttribute("href", href);
    anchor.setAttribute("data-mx-pill", "true");
    anchor.textContent = "@Alice";

    const rules = UserMention.config.parseHTML!.call({} as never)!;

    expect(rules[0]!.getAttrs!(anchor)).toBe(false);
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
    expect(attrs.href).toBe("https://matrix.to/#/%21abc%3Aexample.org");
    expect(text).toBe("#General");
  });

  it("configures its trigger character as #", () => {
    expect(RoomMention.options.suggestion.char).toBe("#");
  });
});
