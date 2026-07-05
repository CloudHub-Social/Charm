import { describe, expect, it } from "vitest";
import { parseCheckCode, sanitizeCheckCodeInput } from "./qrCheckCode";

describe("sanitizeCheckCodeInput", () => {
  it("strips non-digit characters", () => {
    expect(sanitizeCheckCodeInput("a1b2")).toBe("12");
  });

  it("caps length at 2", () => {
    expect(sanitizeCheckCodeInput("12345")).toBe("12");
  });

  it("returns an empty string unchanged", () => {
    expect(sanitizeCheckCodeInput("")).toBe("");
  });
});

describe("parseCheckCode", () => {
  it("parses a valid two-digit code", () => {
    expect(parseCheckCode("42")).toBe(42);
  });

  it("parses a single-digit code", () => {
    expect(parseCheckCode("7")).toBe(7);
  });

  it("returns null for an empty string", () => {
    expect(parseCheckCode("")).toBeNull();
  });

  it("returns null for a value over 99", () => {
    expect(parseCheckCode("100")).toBeNull();
  });

  it("returns null for a non-numeric string", () => {
    expect(parseCheckCode("ab")).toBeNull();
  });
});
