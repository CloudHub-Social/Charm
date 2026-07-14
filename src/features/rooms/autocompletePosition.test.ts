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
    ).toEqual({ top: 124, left: 100, maxHeight: 240 });
  });

  it("clamps the menu inside the right edge on a phone viewport", () => {
    expect(
      rectToAutocompletePosition(rect({ top: 100, right: 360, bottom: 120, left: 340 }), {
        width: 375,
        height: 812,
      }),
    ).toEqual({ top: 124, left: 111, maxHeight: 240 });
  });

  it("flips above the caret when there is not enough room below", () => {
    expect(
      rectToAutocompletePosition(rect({ top: 700, right: 120, bottom: 720, left: 100 }), {
        width: 375,
        height: 812,
      }),
    ).toEqual({ top: 456, left: 100, maxHeight: 240 });
  });

  it("uses the roomier side and caps the menu on a short viewport", () => {
    expect(
      rectToAutocompletePosition(rect({ top: 80, right: 30, bottom: 100, left: 10 }), {
        width: 320,
        height: 200,
      }),
    ).toEqual({ top: 104, left: 10, maxHeight: 88 });
  });

  it("uses partial room below when neither side fits the full menu", () => {
    expect(
      rectToAutocompletePosition(rect({ top: 20, right: 30, bottom: 40, left: 10 }), {
        width: 320,
        height: 200,
      }),
    ).toEqual({ top: 44, left: 10, maxHeight: 148 });
  });

  it("uses the visual viewport when the software keyboard reduces visible height", () => {
    const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: { width: 375, height: 400 },
    });

    try {
      expect(
        rectToAutocompletePosition(rect({ top: 340, right: 120, bottom: 360, left: 100 })),
      ).toEqual({ top: 96, left: 100, maxHeight: 240 });
    } finally {
      if (original) Object.defineProperty(window, "visualViewport", original);
      else Reflect.deleteProperty(window, "visualViewport");
    }
  });

  it("normalizes caret coordinates when the visual viewport is panned", () => {
    const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: { width: 375, height: 400, offsetTop: 300, offsetLeft: 20 },
    });

    try {
      expect(
        rectToAutocompletePosition(rect({ top: 340, right: 140, bottom: 360, left: 120 })),
      ).toEqual({ top: 64, left: 100, maxHeight: 240 });
    } finally {
      if (original) Object.defineProperty(window, "visualViewport", original);
      else Reflect.deleteProperty(window, "visualViewport");
    }
  });
});
