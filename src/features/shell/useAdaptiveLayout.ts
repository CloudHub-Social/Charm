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
    width:
      typeof window === "undefined" || typeof window.matchMedia !== "function"
        ? "wide"
        : matches(QUERIES.wide)
          ? "wide"
          : matches(QUERIES.medium)
            ? "medium"
            : "compact",
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
 * The opt-in state interface lets shell migration proceed independently. */
export function useAdaptiveLayout(): LayoutMode;
export function useAdaptiveLayout(options: { adaptive: true }): AdaptiveLayout;
export function useAdaptiveLayout(options?: { adaptive: true }): LayoutMode | AdaptiveLayout {
  const state = useAdaptiveLayoutState();
  return options?.adaptive ? state : state.width === "compact" ? "mobile" : "desktop";
}
