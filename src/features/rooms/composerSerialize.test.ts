import { describe, expect, it } from "vitest";
import { serializeComposerContent } from "./composerSerialize";
import { sanitizeMatrixHtml } from "./composerSanitize";

describe("serializeComposerContent", () => {
  it("sends text_plain only (no formattedBody) for unformatted text", () => {
    const result = serializeComposerContent("<p>hello world</p>", "hello world");
    expect(result.body).toBe("hello world");
    expect(result.formattedBody).toBeNull();
  });

  it("keeps formattedBody for bold text", () => {
    const result = serializeComposerContent("<p><strong>hello</strong></p>", "hello");
    expect(result.formattedBody).toContain("<strong>hello</strong>");
  });

  it("keeps formattedBody for italic text", () => {
    const result = serializeComposerContent("<p><em>hello</em></p>", "hello");
    expect(result.formattedBody).toContain("<em>hello</em>");
  });

  it("keeps formattedBody for inline code", () => {
    const result = serializeComposerContent("<p><code>hello</code></p>", "hello");
    expect(result.formattedBody).toContain("<code>hello</code>");
  });

  it("keeps formattedBody for a blockquote", () => {
    const result = serializeComposerContent("<blockquote><p>hello</p></blockquote>", "hello");
    expect(result.formattedBody).toContain("<blockquote>");
  });

  it("keeps formattedBody for an ordered list", () => {
    const result = serializeComposerContent("<ol><li><p>one</p></li></ol>", "one");
    expect(result.formattedBody).toContain("<ol>");
    expect(result.formattedBody).toContain("<li>");
  });

  it("keeps formattedBody for an unordered list", () => {
    const result = serializeComposerContent("<ul><li><p>one</p></li></ul>", "one");
    expect(result.formattedBody).toContain("<ul>");
  });

  it("keeps formattedBody for a link", () => {
    const result = serializeComposerContent(
      '<p><a href="https://example.org">example</a></p>',
      "example",
    );
    expect(result.formattedBody).toContain('<a href="https://example.org">example</a>');
  });

  it("drops disallowed tags like <script>", () => {
    const result = serializeComposerContent("<p>hi<script>alert(1)</script></p>", "hi");
    expect(result.formattedBody ?? "").not.toContain("<script>");
    expect(result.formattedBody ?? "").not.toContain("alert(1)");
  });

  it("drops event-handler attributes", () => {
    const result = serializeComposerContent('<p><img src="x.png" onerror="alert(1)"></p>', "");
    expect(result.formattedBody ?? "").not.toContain("onerror");
  });

  it("returns null mentions when there are none", () => {
    const result = serializeComposerContent("<p>hi</p>", "hi", []);
    expect(result.mentions).toBeNull();
  });

  it("returns the mention user ids when present", () => {
    const result = serializeComposerContent("<p>hi @alice</p>", "hi @alice", [
      "@alice:example.org",
    ]);
    expect(result.mentions).toEqual(["@alice:example.org"]);
  });
});

describe("sanitizeMatrixHtml", () => {
  it("strips <script> tags entirely", () => {
    expect(sanitizeMatrixHtml("<script>alert(1)</script>hello")).toBe("hello");
  });

  it("strips javascript: URLs from href", () => {
    const out = sanitizeMatrixHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain("javascript:");
  });

  it("strips onerror handlers", () => {
    const out = sanitizeMatrixHtml('<img src="x.png" onerror="alert(1)">');
    expect(out).not.toContain("onerror");
  });

  it("keeps allowlisted formatting tags", () => {
    const out = sanitizeMatrixHtml("<p><strong>bold</strong> and <em>italic</em></p>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
  });

  it("drops disallowed tags like <iframe>", () => {
    const out = sanitizeMatrixHtml('<iframe src="evil.com"></iframe>hello');
    expect(out).not.toContain("<iframe");
    expect(out).toContain("hello");
  });

  it("drops the class attribute", () => {
    const out = sanitizeMatrixHtml('<p class="fixed inset-0 z-50">hi</p>');
    expect(out).not.toContain("class");
  });

  it("keeps only a safe language token from a multi-class code element", () => {
    const out = sanitizeMatrixHtml(
      '<pre><code class="hljs language-js fixed">const charm = true;</code></pre>',
    );
    expect(out).toContain('class="language-js"');
    expect(out).not.toContain("hljs");
    expect(out).not.toContain("fixed");
  });

  it("keeps <s> strikethrough tags", () => {
    const out = sanitizeMatrixHtml("<s>struck</s>");
    expect(out).toContain("<s>struck</s>");
  });

  it("strips an <img> src that isn't an mxc:// URI", () => {
    const out = sanitizeMatrixHtml('<img src="https://tracker.example/pixel.png">');
    expect(out).not.toContain("tracker.example");
  });

  it("keeps an <img> src that is an mxc:// URI", () => {
    const out = sanitizeMatrixHtml('<img src="mxc://example.org/abc123">');
    expect(out).toContain("mxc://example.org/abc123");
  });
});
