import { useEffect, useState } from "react";

/** Compatibility mode for consumers awaiting the staged adaptive migration. */
export type LayoutMode = "desktop" | "mobile";
export type AdaptiveWidth = "compact" | "medium" | "wide";

export interface AdaptiveLayout {
  width: AdaptiveWidth;
  /** Primary pointing device; independent of viewport width. */
  pointer: "coarse" | "fine" | "none";
  hover: boolean;
  /** Hybrid devices may have touch and a mouse at the same time. */
  anyCoarsePointer: boolean;
  anyFinePointer: boolean;
}

const QUERIES = {
  medium: "(min-width: 768px)",
  wide: "(min-width: 1200px)",
  coarse: "(pointer: coarse)",
  fine: "(pointer: fine)",
  hover: "(hover: hover)",
  anyCoarse: "(any-pointer: coarse)",
  anyFine: "(any-pointer: fine)",
} as const;

/** Width never implies touch, hover, or keyboard availability. Keyboard access
 * remains available in every mode, including touch-primary tablets. */
function readAdaptiveLayout(): AdaptiveLayout {
  const matches = (query: string) =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(query).matches;
  return {
    width: matches(QUERIES.wide) ? "wide" : matches(QUERIES.medium) ? "medium" : "compact",
    pointer: matches(QUERIES.coarse) ? "coarse" : matches(QUERIES.fine) ? "fine" : "none",
    hover: matches(QUERIES.hover),
    anyCoarsePointer: matches(QUERIES.anyCoarse),
    anyFinePointer: matches(QUERIES.anyFine),
  };
}

export function useAdaptiveLayoutState(): AdaptiveLayout {
  const [state, setState] = useState<AdaptiveLayout>(readAdaptiveLayout);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const queries = Object.values(QUERIES).map((query) => window.matchMedia(query));
    const update = () => setState(readAdaptiveLayout());
    update();
    queries.forEach((query) => query.addEventListener("change", update));
    return () => queries.forEach((query) => query.removeEventListener("change", update));
  }, []);

  return state;
}

/** Retains the two-state interface for ChatShell, RoomsScreen and settings.
 * New shell decisions use useAdaptiveLayoutState instead. */
export function useAdaptiveLayout(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(() =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 767px)").matches
      ? "mobile"
      : "desktop",
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setMode(query.matches ? "mobile" : "desktop");
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return mode;
}
