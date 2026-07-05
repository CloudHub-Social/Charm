import { useCallback, useRef, useState } from "react";
import type { AutocompleteItem } from "./AutocompletePopover";

export interface SuggestionMenuState {
  open: boolean;
  items: AutocompleteItem[];
  activeIndex: number;
  position: { top: number; left: number };
}

const CLOSED_STATE: SuggestionMenuState = {
  open: false,
  items: [],
  activeIndex: 0,
  position: { top: 0, left: 0 },
};

/**
 * Bridges TipTap's `suggestion` plugin callbacks (which run outside React's
 * render cycle — `onStart`/`onUpdate`/`onExit`/`onKeyDown`) to a single
 * shared piece of React state, so all four providers (slash/emoji/user
 * mention/room mention) render into the same {@link AutocompletePopover}
 * and only one can be open at a time. `pendingSelectRef` holds whichever
 * provider's "commit index N" callback is current, since which provider is
 * active can change between renders.
 */
export function useSuggestionMenu() {
  const [state, setState] = useState<SuggestionMenuState>(CLOSED_STATE);
  const pendingSelectRef = useRef<((index: number) => void) | null>(null);

  const open = useCallback(
    (
      items: AutocompleteItem[],
      position: { top: number; left: number },
      onSelect: (index: number) => void,
    ) => {
      pendingSelectRef.current = onSelect;
      setState({ open: true, items, activeIndex: 0, position });
    },
    [],
  );

  const update = useCallback(
    (
      items: AutocompleteItem[],
      position: { top: number; left: number },
      onSelect: (index: number) => void,
    ) => {
      pendingSelectRef.current = onSelect;
      setState((prev) => ({
        ...prev,
        items,
        position,
        activeIndex: Math.min(prev.activeIndex, Math.max(items.length - 1, 0)),
      }));
    },
    [],
  );

  const close = useCallback(() => {
    pendingSelectRef.current = null;
    setState(CLOSED_STATE);
  }, []);

  const moveActive = useCallback((delta: number) => {
    setState((prev) => {
      if (prev.items.length === 0) return prev;
      const next = (prev.activeIndex + delta + prev.items.length) % prev.items.length;
      return { ...prev, activeIndex: next };
    });
  }, []);

  const selectActive = useCallback(() => {
    setState((prev) => {
      pendingSelectRef.current?.(prev.activeIndex);
      return prev;
    });
  }, []);

  const selectIndex = useCallback((index: number) => {
    pendingSelectRef.current?.(index);
  }, []);

  return { state, open, update, close, moveActive, selectActive, selectIndex };
}

export type SuggestionMenuApi = ReturnType<typeof useSuggestionMenu>;
