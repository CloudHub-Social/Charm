import { describe, expect, it } from "vitest";
import { firstUrlInText } from "./extractUrl";

describe("firstUrlInText", () => {
  it("returns null when the text has no URL", () => {
    expect(firstUrlInText("just some plain text, no links here")).toBeNull();
  });

  it("finds a bare https URL", () => {
    expect(firstUrlInText("check this out: https://example.com/path")).toBe(
      "https://example.com/path",
    );
  });

  it("finds a bare http URL", () => {
    expect(firstUrlInText("http://example.com")).toBe("http://example.com");
  });

  it("returns only the first URL when multiple are present", () => {
    expect(firstUrlInText("https://first.example.com and https://second.example.com")).toBe(
      "https://first.example.com",
    );
  });

  it("ignores non-http(s) links like mailto", () => {
    expect(firstUrlInText("email me at someone@example.com")).toBeNull();
  });

  it("skips a leading non-http(s) URL in favor of a later http(s) one", () => {
    expect(firstUrlInText("grab it via ftp://host/file.zip or https://example.com/file.zip")).toBe(
      "https://example.com/file.zip",
    );
  });

  it("returns null when the only URL present isn't http(s)", () => {
    expect(firstUrlInText("see ftp://host/file.zip")).toBeNull();
  });

  it("prefers formattedBody over the plain-text body when both are given", () => {
    expect(
      firstUrlInText(
        "check https://plain.example.com",
        "<p>check <a href='https://formatted.example.com'>this</a></p>",
      ),
    ).toBe("https://formatted.example.com");
  });

  it("excludes a URL that's only present inside a spoiler span", () => {
    expect(
      firstUrlInText(
        "spoiler: https://secret.example.com/reveal",
        '<span data-mx-spoiler="">https://secret.example.com/reveal</span>',
      ),
    ).toBeNull();
  });

  it("still finds a non-spoilered URL when a spoiler is also present", () => {
    expect(
      firstUrlInText(
        "https://secret.example.com/reveal and https://public.example.com",
        '<span data-mx-spoiler="">https://secret.example.com/reveal</span> and <a href="https://public.example.com">link</a>',
      ),
    ).toBe("https://public.example.com");
  });

  it("falls back to plain body when formattedBody is null or undefined", () => {
    expect(firstUrlInText("https://example.com", null)).toBe("https://example.com");
    expect(firstUrlInText("https://example.com", undefined)).toBe("https://example.com");
  });

  it("excludes a Matrix pill's matrix.to href from preview candidates", () => {
    expect(
      firstUrlInText(
        "hey @alice",
        '<a data-mx-pill href="https://matrix.to/#/@alice:example.org">Alice</a>',
      ),
    ).toBeNull();
  });

  it("still finds a real link alongside an unrelated Matrix pill mention", () => {
    expect(
      firstUrlInText(
        "hey @alice check https://example.com",
        '<a data-mx-pill href="https://matrix.to/#/@alice:example.org">Alice</a> check <a href="https://example.com">this</a>',
      ),
    ).toBe("https://example.com");
  });

  it("excludes a Matrix pill's display-name text even when it looks URL-shaped", () => {
    expect(
      firstUrlInText(
        "hey @https://not-a-real-link.example",
        '<a data-mx-pill href="https://matrix.to/#/@alice:example.org">https://not-a-real-link.example</a>',
      ),
    ).toBeNull();
  });

  it("preserves document order: an earlier labeled link wins over a later bare URL", () => {
    expect(
      firstUrlInText(
        "https://second.example and https://first.example",
        '<a href="https://first.example">label</a> ... https://second.example',
      ),
    ).toBe("https://first.example");
  });

  it("excludes a URL-looking string inside a code block", () => {
    expect(
      firstUrlInText(
        "curl https://api.example.com/endpoint",
        "<code>curl https://api.example.com/endpoint</code>",
      ),
    ).toBeNull();
  });

  it("excludes a URL inside a fenced <pre><code> block", () => {
    expect(
      firstUrlInText(
        "GET https://api.example.com/endpoint",
        "<pre><code>GET https://api.example.com/endpoint</code></pre>",
      ),
    ).toBeNull();
  });

  it("still finds a real link when a code block with a URL-looking string is also present", () => {
    expect(
      firstUrlInText(
        "curl https://internal.example.com and see https://docs.example.com",
        '<code>curl https://internal.example.com</code> and see <a href="https://docs.example.com">docs</a>',
      ),
    ).toBe("https://docs.example.com");
  });
});
