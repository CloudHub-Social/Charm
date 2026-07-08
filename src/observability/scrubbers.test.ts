import { describe, expect, it } from "vitest";
import { scrubSensitiveText, scrubSentryValue } from "./scrubbers";

describe("observability scrubbers", () => {
  it("redacts Matrix identifiers and secret fields", () => {
    const text =
      'room !abcdef:matrix.example user @alice:example.org alias #general:example.org event $event:example.org mxc://example.org/media access_token="secret"';

    expect(scrubSensitiveText(text)).toBe(
      'room ![redacted]:[redacted] user @[redacted]:[redacted] alias #[redacted]:[redacted] event $[redacted]:[redacted] mxc://[redacted]/[redacted] access_token="[redacted]"',
    );
  });

  it("recursively redacts Sentry payload strings", () => {
    const payload = {
      message: "failed in !room:example.org",
      extra: {
        password: "safe because keys alone are not sent",
        nested: ["@user:example.org", "plain string"],
      },
    };

    expect(scrubSentryValue(payload)).toEqual({
      message: "failed in ![redacted]:[redacted]",
      extra: {
        password: "safe because keys alone are not sent",
        nested: ["@[redacted]:[redacted]", "plain string"],
      },
    });
  });
});
