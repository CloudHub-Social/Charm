import type { AutocompletePosition } from "./AutocompletePopover";

const AUTOCOMPLETE_WIDTH = 256;
const AUTOCOMPLETE_MAX_HEIGHT = 240;
const AUTOCOMPLETE_MARGIN = 8;
const AUTOCOMPLETE_GAP = 4;

/** Keeps the caret-anchored suggestion menu inside the visible browser viewport. */
export function rectToAutocompletePosition(
  rect: DOMRect | null | undefined,
  viewport = { width: window.innerWidth, height: window.innerHeight },
): AutocompletePosition {
  if (!rect) return { top: 0, left: 0 };

  const left = Math.max(
    AUTOCOMPLETE_MARGIN,
    Math.min(rect.left, viewport.width - AUTOCOMPLETE_WIDTH - AUTOCOMPLETE_MARGIN),
  );
  const below = rect.bottom + AUTOCOMPLETE_GAP;
  const top =
    below + AUTOCOMPLETE_MAX_HEIGHT <= viewport.height - AUTOCOMPLETE_MARGIN
      ? below
      : Math.max(AUTOCOMPLETE_MARGIN, rect.top - AUTOCOMPLETE_MAX_HEIGHT - AUTOCOMPLETE_GAP);

  return { top, left };
}
