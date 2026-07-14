import { useCallback, useRef, useState } from "react";
import type { AutocompleteItem, AutocompletePosition } from "./AutocompletePopover";

export interface SuggestionMenuState {
  open: boolean;
  items: AutocompleteItem[];
  activeIndex: number;
  position: AutocompletePosition;
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
  // Mirrors `state.activeIndex` outside the setState updater — `selectActive`
  // is called from a stable closure created once (Composer's
  // `editorProps.handleKeyDown`) and needs the *current* index at call time,
  // not whatever it closed over. Reading (and calling `pendingSelectRef`)
  // from inside a `setState` updater instead would run under React Strict
  // Mode's deliberate double-invocation of updaters, firing the selection
  // callback twice.
  const activeIndexRef = useRef(0);
  activeIndexRef.current = state.activeIndex;

  const open = useCallback(
    (
      items: AutocompleteItem[],
      position: AutocompletePosition,
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
      position: AutocompletePosition,
      onSelect: (index: number) => void,
    ) => {
      pendingSelectRef.current = onSelect;
      setState((prev) => ({
        // `open: true` (not `...prev`'s possibly-still-false `open`) — an
        // `onStart` that raced ahead of async data (e.g. room members not
        // loaded yet) bails without opening when its first item list is
        // empty; without forcing `open` here too, a later `onUpdate` that
        // finally has real items would set them into state but the popover
        // would never actually become visible.
        ...prev,
        open: true,
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
    pendingSelectRef.current?.(activeIndexRef.current);
  }, []);

  const selectIndex = useCallback((index: number) => {
    pendingSelectRef.current?.(index);
  }, []);

  return { state, open, update, close, moveActive, selectActive, selectIndex };
}

export type SuggestionMenuApi = ReturnType<typeof useSuggestionMenu>;
