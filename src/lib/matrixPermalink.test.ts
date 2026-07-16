import { describe, expect, it } from "vitest";
import { eventPermalink, userIdServerName } from "./matrixPermalink";

describe("eventPermalink", () => {
  it("builds a fully percent-encoded matrix.to room-event permalink", () => {
    expect(
      eventPermalink("!somewhere:example.org", "$event:example.org", "client.example.org"),
    ).toBe(
      "https://matrix.to/#/%21somewhere%3Aexample.org/%24event%3Aexample.org?via=client.example.org",
    );
  });

  it("encodes slash and RFC 3986 reserved punctuation inside opaque ids", () => {
    expect(eventPermalink("!room/part:example.org", "$event!*:example.org", "[::1]:8448")).toBe(
      "https://matrix.to/#/%21room%2Fpart%3Aexample.org/%24event%21%2A%3Aexample.org?via=%5B%3A%3A1%5D%3A8448",
    );
  });

  it("derives a routing server from the current Matrix user id", () => {
    expect(userIdServerName("@evie:matrix.example.org:8448")).toBe("matrix.example.org:8448");
    expect(userIdServerName("not-a-user-id")).toBeNull();
  });
});
