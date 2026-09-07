import { useCallback, useState } from "react";
import {
  clampRoomSidebarWidth,
  DEFAULT_PANE_PREFERENCES,
  type PanePreferences,
} from "./navigationState";

const STORAGE_KEY = "charm:pane-preferences:v1";

function readPanePreferences(): PanePreferences {
  if (typeof window === "undefined") return DEFAULT_PANE_PREFERENCES;
  try {
    const value = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "null",
    ) as Partial<PanePreferences> | null;
    if (value?.version !== 1 || typeof value.roomSidebarWidth !== "number") {
      return DEFAULT_PANE_PREFERENCES;
    }
    return { version: 1, roomSidebarWidth: clampRoomSidebarWidth(value.roomSidebarWidth) };
  } catch {
    return DEFAULT_PANE_PREFERENCES;
  }
}

export function usePanePreferences() {
  const [preferences, setPreferences] = useState(readPanePreferences);
  const setRoomSidebarWidth = useCallback((width: number) => {
    const next: PanePreferences = {
      version: 1,
      roomSidebarWidth: clampRoomSidebarWidth(width),
    };
    setPreferences(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Pane sizing is a convenience. A full/blocked local store must never
      // prevent navigation or resize the app into an unusable state.
    }
  }, []);
  return { preferences, setRoomSidebarWidth };
}
