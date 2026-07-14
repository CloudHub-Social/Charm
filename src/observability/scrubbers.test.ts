import { describe, expect, it } from "vitest";
import { scrubSensitiveText, scrubSentryValue, summarizeErrorText } from "./scrubbers";

describe("observability scrubbers", () => {
  it("redacts Matrix identifiers and secret fields", () => {
    const text =
      'room !abcdef:matrix.example user @alice:example.org alias #general:example.org event $event:example.org mxc://example.org/media access_token="secret"';

    expect(scrubSensitiveText(text)).toBe(
      'room ![redacted]:[redacted] user @[redacted]:[redacted] alias #[redacted]:[redacted] event $[redacted]:[redacted] mxc://[redacted]/[redacted] access_token="[redacted]"',
    );
  });

  it("redacts homeserver/plain URLs, preserving only the scheme", () => {
    expect(scrubSensitiveText("failed to connect to https://matrix.example.org:8448/_matrix")).toBe(
      "failed to connect to https://[redacted]",
    );
    expect(scrubSensitiveText("see http://example.org/path")).toBe("see http://[redacted]");
    expect(scrubSensitiveText("see HTTPS://example.org/path")).toBe("see https://[redacted]");
    expect(scrubSensitiveText("see HTTP://example.org/path")).toBe("see http://[redacted]");
  });

  it("does not touch already-redacted mxc:// URIs when scrubbing URLs", () => {
    const alreadyScrubbed = "media at mxc://[redacted]/[redacted]";
    expect(scrubSensitiveText(alreadyScrubbed)).toBe(alreadyScrubbed);
  });

  it("redacts multi-word quoted secret values instead of leaking everything after the first space", () => {
    expect(scrubSensitiveText('password="correct horse battery"')).toBe('password="[redacted]"');
    expect(scrubSensitiveText("passphrase='correct horse battery'")).toBe(
      "passphrase='[redacted]'",
    );
  });

  it("redacts a secret value with an unterminated quote (no closing quote)", () => {
    expect(scrubSensitiveText('access_token="abc123')).toBe('access_token="[redacted]');
    expect(scrubSensitiveText("session_key='abc123")).toBe("session_key='[redacted]");
  });

  it("redacts a quoted secret containing an escaped quote instead of stopping early", () => {
    expect(scrubSensitiveText('password="abc\\"tail"')).toBe('password="[redacted]"');
  });

  it("doesn't re-match an already-redacted URL placeholder and leave a stray bracket or leak the host", () => {
    // scrubUrls runs first and replaces the URL with the literal text
    // `https://[redacted]`. Before excluding `[`/`{` from the unquoted
    // value's character class, scrubSecrets would then partially re-match
    // into that placeholder (stopping at the `]` inside it) and leave a
    // stray, mangled `[redacted]]` behind. The important property is no
    // leaked host and no malformed trailing bracket — not a specific
    // cosmetic string, since the two independent passes both use literal
    // `[`/`]` text.
    const result = scrubSensitiveText("access_token=https://example.com");
    expect(result).not.toContain("example.com");
    expect(result).not.toMatch(/]]/);
  });

  it("reports the scrubbed (not original) length when truncating error text", () => {
    const value = `password="${"x".repeat(400)}"`;
    const result = summarizeErrorText(value);
    expect(result).toContain('password="[redacted]"');
    // Scrubbing shrinks the string well under the truncation cap, so no
    // truncation marker should appear at all.
    expect(result).not.toContain("truncated");
  });

  it("reports scrubbed length, not original length, when the string is still over the cap after scrubbing", () => {
    const value = `${"x".repeat(350)} password="secret"`;
    const scrubbedLength = value.length - "secret".length + "[redacted]".length;

    const result = summarizeErrorText(value);

    expect(result).toContain(`…[truncated, full length ${scrubbedLength}]`);
    expect(scrubbedLength).not.toBe(value.length);
  });

  it("recursively redacts Sentry payload strings", () => {
    const payload = {
      message: "failed in !room:example.org",
      extra: {
        password: "secret",
        access_token: "token",
        nested: ["@user:example.org", "plain string"],
      },
    };

    expect(scrubSentryValue(payload)).toEqual({
      message: "failed in ![redacted]:[redacted]",
      extra: {
        password: "[redacted]",
        access_token: "[redacted]",
        nested: ["@[redacted]:[redacted]", "plain string"],
      },
    });
  });
});
