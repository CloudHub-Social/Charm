import { describe, expect, it } from "vitest";
import { eventPermalink } from "./matrixPermalink";

describe("eventPermalink", () => {
  it("builds a fully percent-encoded matrix.to room-event permalink", () => {
    expect(eventPermalink("!somewhere:example.org", "$event:example.org")).toBe(
      "https://matrix.to/#/%21somewhere%3Aexample.org/%24event%3Aexample.org",
    );
  });

  it("encodes slash and RFC 3986 reserved punctuation inside opaque ids", () => {
    expect(eventPermalink("!room/part:example.org", "$event!*:example.org")).toBe(
      "https://matrix.to/#/%21room%2Fpart%3Aexample.org/%24event%21%2A%3Aexample.org",
    );
  });
});
