import { describe, expect, it } from "vitest";
import { rectToAutocompletePosition } from "./autocompletePosition";

function rect({ top, right, bottom, left }: Pick<DOMRect, "top" | "right" | "bottom" | "left">) {
  return { top, right, bottom, left } as DOMRect;
}

describe("rectToAutocompletePosition", () => {
  it("uses the caret's lower-left corner when the menu fits", () => {
    expect(
      rectToAutocompletePosition(rect({ top: 100, right: 120, bottom: 120, left: 100 }), {
        width: 800,
        height: 800,
      }),
    ).toEqual({ top: 124, left: 100 });
  });

  it("clamps the menu inside the right edge on a phone viewport", () => {
    expect(
      rectToAutocompletePosition(rect({ top: 100, right: 360, bottom: 120, left: 340 }), {
        width: 375,
        height: 812,
      }),
    ).toEqual({ top: 124, left: 111 });
  });

  it("flips above the caret when there is not enough room below", () => {
    expect(
      rectToAutocompletePosition(rect({ top: 700, right: 120, bottom: 720, left: 100 }), {
        width: 375,
        height: 812,
      }),
    ).toEqual({ top: 456, left: 100 });
  });

  it("keeps a flipped menu within the top margin on a short viewport", () => {
    expect(
      rectToAutocompletePosition(rect({ top: 80, right: 30, bottom: 100, left: 10 }), {
        width: 320,
        height: 200,
      }),
    ).toEqual({ top: 8, left: 10 });
  });
});
