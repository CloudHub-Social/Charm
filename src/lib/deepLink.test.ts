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

  it("returns null for unrelated URLs", () => {
    expect(parseRoomTarget("https://example.com/not-a-deep-link")).toBeNull();
  });

  it("returns null for a charm:// URL that isn't a room link", () => {
    expect(parseRoomTarget("charm://something-else")).toBeNull();
  });
});
