import { describe, expect, it } from "vitest";
import { parseRoomTarget } from "./deepLink";

describe("parseRoomTarget", () => {
  it("parses a charm:// room link, decoding the room id", () => {
    expect(parseRoomTarget(`charm://room/${encodeURIComponent("!abc123:localhost")}`)).toBe(
      "!abc123:localhost",
    );
  });

  it("parses a matrix.to room-id link", () => {
    expect(parseRoomTarget("https://matrix.to/#/!abc123:localhost")).toBe("!abc123:localhost");
  });

  it("parses and decodes a matrix.to alias link", () => {
    expect(parseRoomTarget("https://matrix.to/#/%23general:localhost")).toBe("#general:localhost");
  });

  it("ignores a query string suffix on a matrix.to link", () => {
    expect(parseRoomTarget("https://matrix.to/#/!abc123:localhost?via=localhost")).toBe(
      "!abc123:localhost",
    );
  });

  it("extracts the room from a matrix.to event permalink", () => {
    expect(
      parseRoomTarget(
        "https://matrix.to/#/%21abc123%3Alocalhost/%24event%3Alocalhost?via=localhost",
      ),
    ).toBe("!abc123:localhost");
  });

  it("preserves historically unencoded slashes in matrix.to room aliases", () => {
    expect(parseRoomTarget("https://matrix.to/#/#team/foo:localhost")).toBe("#team/foo:localhost");
  });

  it("still separates an event from an alias with an unencoded slash", () => {
    expect(
      parseRoomTarget("https://matrix.to/#/#team/foo:localhost/$event:localhost?via=localhost"),
    ).toBe("#team/foo:localhost");
  });

  it("returns null for unrelated URLs", () => {
    expect(parseRoomTarget("https://example.com/not-a-deep-link")).toBeNull();
  });

  it("returns null for a charm:// URL that isn't a room link", () => {
    expect(parseRoomTarget("charm://something-else")).toBeNull();
  });

  it("does not treat a matrix.to fragment embedded in an unrelated charm:// URL as a room link", () => {
    expect(
      parseRoomTarget("charm://anything?x=https://matrix.to/#/!some-room:evil.com"),
    ).toBeNull();
  });

  it("does not treat a matrix.to fragment embedded in an unrelated https URL as a room link", () => {
    expect(
      parseRoomTarget("https://evil.example/?x=https://matrix.to/#/!some-room:evil.com"),
    ).toBeNull();
  });
});
