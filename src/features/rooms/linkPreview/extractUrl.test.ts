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
});
