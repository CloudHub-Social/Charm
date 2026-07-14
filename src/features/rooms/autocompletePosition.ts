import type { AutocompletePosition } from "./AutocompletePopover";

const AUTOCOMPLETE_WIDTH = 256;
const AUTOCOMPLETE_MAX_HEIGHT = 240;
const AUTOCOMPLETE_MARGIN = 8;
const AUTOCOMPLETE_GAP = 4;

/** Keeps the caret-anchored suggestion menu inside the visible browser viewport. */
export function rectToAutocompletePosition(
  rect: DOMRect | null | undefined,
  viewport = {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  },
): AutocompletePosition {
  if (!rect) return { top: 0, left: 0, maxHeight: AUTOCOMPLETE_MAX_HEIGHT };

  const left = Math.max(
    AUTOCOMPLETE_MARGIN,
    Math.min(rect.left, viewport.width - AUTOCOMPLETE_WIDTH - AUTOCOMPLETE_MARGIN),
  );
  const below = rect.bottom + AUTOCOMPLETE_GAP;
  const availableBelow = Math.max(0, viewport.height - AUTOCOMPLETE_MARGIN - below);
  const availableAbove = Math.max(0, rect.top - AUTOCOMPLETE_GAP - AUTOCOMPLETE_MARGIN);
  const opensBelow = availableBelow >= AUTOCOMPLETE_MAX_HEIGHT || availableBelow >= availableAbove;
  const maxHeight = Math.min(AUTOCOMPLETE_MAX_HEIGHT, opensBelow ? availableBelow : availableAbove);
  const top = opensBelow
    ? below
    : Math.max(AUTOCOMPLETE_MARGIN, rect.top - maxHeight - AUTOCOMPLETE_GAP);

  return { top, left, maxHeight };
}
