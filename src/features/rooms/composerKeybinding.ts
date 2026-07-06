/**
 * Enter-vs-menu decision, extracted as a pure function so it's testable
 * independent of TipTap/ProseMirror's keydown dispatch: Enter sends (unless
 * Shift+Enter, which always inserts a newline), UNLESS the autocomplete menu
 * is open, in which case Enter selects the highlighted item instead —
 * per the spec's acceptance criterion 7.
 */
export function resolveEnterKeyAction(
  shiftKey: boolean,
  menuOpen: boolean,
): "newline" | "select-menu-item" | "send" {
  if (shiftKey) return "newline";
  if (menuOpen) return "select-menu-item";
  return "send";
}
