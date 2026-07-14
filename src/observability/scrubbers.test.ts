import { describe, expect, it } from "vitest";
import { scrubSensitiveText, scrubSentryValue, scrubUrls, summarizeErrorText } from "./scrubbers";

describe("observability scrubbers", () => {
  it("redacts Matrix identifiers and secret fields", () => {
    const text =
      'room !abcdef:matrix.example user @alice:example.org alias #general:example.org event $event:example.org mxc://example.org/media access_token="secret"';

    expect(scrubSensitiveText(text)).toBe(
      'room ![redacted]:[redacted] user @[redacted]:[redacted] alias #[redacted]:[redacted] event $[redacted]:[redacted] mxc://[redacted]/[redacted] access_token="[redacted]"',
    );
  });

  it("redacts generic *secret-suffixed fields, not just the explicitly named ones", () => {
    expect(scrubSensitiveText("client_secret=abc123")).toBe("client_secret=[redacted]");
    expect(scrubSensitiveText("sharedSecret=abc123")).toBe("sharedSecret=[redacted]");
    expect(scrubSensitiveText('oidc_client_secret="abc 123"')).toBe(
      'oidc_client_secret="[redacted]"',
    );
    // Sanity check the boundary: a field that merely contains "secret" as a
    // substring but doesn't *end* with it shouldn't be swept up.
    expect(scrubSensitiveText("not_a_secret_container=fine")).toBe("not_a_secret_container=fine");
  });

  it("redacts hyphenated field-name variants (access-token, recovery-key, ...), not just snake_case/camelCase", () => {
    expect(scrubSensitiveText("access-token=abc123")).toBe("access-token=[redacted]");
    expect(scrubSensitiveText("refresh-token=abc123")).toBe("refresh-token=[redacted]");
    expect(scrubSensitiveText("recovery-key=abc123")).toBe("recovery-key=[redacted]");
    expect(scrubSensitiveText("session-key=abc123")).toBe("session-key=[redacted]");
    expect(scrubSensitiveText("secret-storage-key=abc123")).toBe("secret-storage-key=[redacted]");
  });

  it("redacts a colonless Matrix event ID (newer opaque-hash format with no :server suffix)", () => {
    const text = "event $AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABC is not an m.room.message";
    expect(scrubSensitiveText(text)).toBe("event $[redacted] is not an m.room.message");
  });

  it("redacts multiple distinct secrets in the same string, not just the first", () => {
    // The value branches use a negated character class ((?:[^"\\]|\\.)*),
    // which can't cross a `"` boundary regardless of quantifier greediness —
    // unlike a naive `.*"` pattern, there's no backtracking that could let
    // the first match's value swallow a second secret later in the string.
    expect(scrubSensitiveText('password="abc" access_token="xyz"')).toBe(
      'password="[redacted]" access_token="[redacted]"',
    );
    expect(scrubSensitiveText("password=abc access_token=xyz")).toBe(
      "password=[redacted] access_token=[redacted]",
    );
  });

  it("does not redact a short $-prefixed string that looks like a price, not an event ID", () => {
    expect(scrubSensitiveText("that costs $100")).toBe("that costs $100");
  });

  it("scrubUrls redacts homeserver/plain URLs, preserving only the scheme", () => {
    expect(scrubUrls("failed to connect to https://matrix.example.org:8448/_matrix")).toBe(
      "failed to connect to https://[redacted]",
    );
    expect(scrubUrls("see http://example.org/path")).toBe("see http://[redacted]");
    expect(scrubUrls("see HTTPS://example.org/path")).toBe("see https://[redacted]");
    expect(scrubUrls("see HTTP://example.org/path")).toBe("see http://[redacted]");
  });

  it("summarizeErrorText redacts homeserver URLs in captured IPC diagnostic text", () => {
    expect(summarizeErrorText("failed to connect to https://matrix.example.org:8448/_matrix")).toBe(
      "failed to connect to https://[redacted]",
    );
  });

  it("scrubSensitiveText/scrubSentryValue do NOT redact URLs — that would strip filename/abs_path from Sentry stack frames", () => {
    // scrubSentryValue runs over the *entire* Sentry event (including
    // exception.values[].stacktrace.frames[].filename/abs_path, which are
    // themselves https:// URLs to JS asset bundles) via instrument.ts's
    // beforeSend*/beforeSendLog hooks. URL redaction is scoped to
    // summarizeErrorText (the IPC-diagnostic-text path) specifically so it
    // doesn't break source-map symbolication for every captured exception.
    const url = "https://tauri.localhost/assets/index-abc123.js";
    expect(scrubSensitiveText(`at ${url}`)).toBe(`at ${url}`);
    expect(scrubSentryValue({ filename: url })).toEqual({ filename: url });
  });

  it("redacts multi-word quoted secret values instead of leaking everything after the first space", () => {
    expect(scrubSensitiveText('password="correct horse battery"')).toBe('password="[redacted]"');
    expect(scrubSensitiveText("passphrase='correct horse battery'")).toBe(
      "passphrase='[redacted]'",
    );
  });

  it("redacts a secret value with an unterminated quote (no closing quote)", () => {
    // No closing quote means the balanced-quote branch can't match, so this
    // falls through to the catch-all fallback (bare `[redacted]`, no
    // preserved leading quote mark) rather than the quote-preserving one.
    expect(scrubSensitiveText('access_token="abc123')).toBe("access_token=[redacted]");
    expect(scrubSensitiveText("session_key='abc123")).toBe("session_key=[redacted]");
  });

  it("redacts a quoted secret containing an escaped quote instead of stopping early", () => {
    expect(scrubSensitiveText('password="abc\\"tail"')).toBe('password="[redacted]"');
  });

  it("redacts a fully bracket/brace-wrapped secret value (some Debug/serde formatters render it this way)", () => {
    expect(scrubSensitiveText("access_token=[abc]")).toBe("access_token=[redacted]");
    expect(scrubSensitiveText("password={abc}")).toBe("password=[redacted]");
    // Multi-word content inside the brackets shouldn't leak either.
    expect(scrubSensitiveText("password=[correct horse battery]")).toBe("password=[redacted]");
  });

  it("redacts a bracket/brace-wrapped secret value with no closing delimiter", () => {
    expect(scrubSensitiveText("access_token=[abc123")).toBe("access_token=[redacted]");
    expect(scrubSensitiveText("password={abc123")).toBe("password=[redacted]");
  });

  it("redacts a secret value that starts with a stray, unmatched closing delimiter", () => {
    // No corresponding opener, so this can't match a balanced branch either
    // — must fall through to the catch-all fallback rather than being left
    // unredacted entirely.
    expect(scrubSensitiveText("password=]hunter2")).toBe("password=[redacted]");
    expect(scrubSensitiveText("access_token=}abc")).toBe("access_token=[redacted]");
  });

  it("cleanly redacts a secret field whose value is itself a URL, without a doubled placeholder", () => {
    // summarizeErrorText runs scrubSecrets *before* scrubUrls specifically so
    // this case works cleanly: scrubSecrets sees the original
    // "access_token=https://example.com" and captures the whole URL as the
    // secret's value in one match, rather than scrubUrls redacting the URL
    // first and scrubSecrets then partially re-matching into the leftover
    // "[redacted]" placeholder text (which used to produce a mangled
    // "access_token=[redacted][redacted]").
    expect(summarizeErrorText("access_token=https://example.com")).toBe("access_token=[redacted]");
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
