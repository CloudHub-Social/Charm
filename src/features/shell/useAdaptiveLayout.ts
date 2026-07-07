import { useEffect, useState } from "react";

export type LayoutMode = "desktop" | "mobile";

/**
 * Below this viewport width the app switches from the sidebar (rooms rail +
 * content) layout to a bottom-nav layout (Spec 10) — matches the design's
 * "mobile / narrow widths" breakpoint, the same one Tailwind's `md:` prefix
 * uses, so this stays consistent with any `md:`-based responsive styling
 * elsewhere in the app.
 */
const MOBILE_BREAKPOINT_QUERY = "(max-width: 767px)";

function resolveMode(query: MediaQueryList | { matches: boolean }): LayoutMode {
  return query.matches ? "mobile" : "desktop";
}

/**
 * Tracks whether the window is currently at a desktop or mobile width via
 * `matchMedia`, updating live on resize — backs `AppShell`'s sidebar vs.
 * bottom-nav switch.
 */
export function useAdaptiveLayout(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return "desktop";
    }
    return resolveMode(window.matchMedia(MOBILE_BREAKPOINT_QUERY));
  });

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(MOBILE_BREAKPOINT_QUERY);
    const handleChange = (event: MediaQueryListEvent | MediaQueryList) =>
      setMode(resolveMode(event));
    handleChange(query);
    query.addEventListener("change", handleChange);
    return () => query.removeEventListener("change", handleChange);
  }, []);

  return mode;
}
