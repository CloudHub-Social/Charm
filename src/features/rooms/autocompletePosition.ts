import type { AutocompletePosition } from "./AutocompletePopover";

const AUTOCOMPLETE_WIDTH = 256;
const AUTOCOMPLETE_MAX_HEIGHT = 240;
const AUTOCOMPLETE_MARGIN = 8;
const AUTOCOMPLETE_GAP = 4;

interface AutocompleteViewport {
  width: number;
  height: number;
  offsetTop?: number;
  offsetLeft?: number;
}

/** Keeps the caret-anchored suggestion menu inside the visible browser viewport. */
export function rectToAutocompletePosition(
  rect: DOMRect | null | undefined,
  viewport: AutocompleteViewport = {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
    offsetTop: window.visualViewport?.offsetTop ?? 0,
    offsetLeft: window.visualViewport?.offsetLeft ?? 0,
  },
  // iOS can pan the visual viewport above the software keyboard. Normalize
  // the layout-viewport caret rect for fit calculations, then convert the
  // chosen fixed-position coordinates back to the layout viewport below.
): AutocompletePosition {
  if (!rect) return { top: 0, left: 0, maxHeight: AUTOCOMPLETE_MAX_HEIGHT };

  const rectTop = rect.top - (viewport.offsetTop ?? 0);
  const rectBottom = rect.bottom - (viewport.offsetTop ?? 0);
  const rectLeft = rect.left - (viewport.offsetLeft ?? 0);
  const left = Math.max(
    AUTOCOMPLETE_MARGIN,
    Math.min(rectLeft, viewport.width - AUTOCOMPLETE_WIDTH - AUTOCOMPLETE_MARGIN),
  );
  const below = rectBottom + AUTOCOMPLETE_GAP;
  const availableBelow = Math.max(0, viewport.height - AUTOCOMPLETE_MARGIN - below);
  const availableAbove = Math.max(0, rectTop - AUTOCOMPLETE_GAP - AUTOCOMPLETE_MARGIN);
  const opensBelow = availableBelow >= AUTOCOMPLETE_MAX_HEIGHT || availableBelow >= availableAbove;
  const maxHeight = Math.min(AUTOCOMPLETE_MAX_HEIGHT, opensBelow ? availableBelow : availableAbove);
  const top = opensBelow
    ? below
    : Math.max(AUTOCOMPLETE_MARGIN, rectTop - maxHeight - AUTOCOMPLETE_GAP);

  return {
    top: top + (viewport.offsetTop ?? 0),
    left: left + (viewport.offsetLeft ?? 0),
    maxHeight,
  };
}
