export type PrimaryDestination = "home" | "direct-messages" | "activity" | "space";

export type ContextPanelKind = "members" | "pinned-messages" | null;

export type MobileRoute = "room-list" | "conversation" | "context-panel" | "activity";

export interface AppNavigationState {
  destination: PrimaryDestination;
  accountId: string;
  spaceId: string | null;
  roomId: string | null;
  contextPanel: ContextPanelKind;
  mobileRoute: MobileRoute;
}

export interface PanePreferences {
  version: 1;
  roomSidebarWidth: number;
}

export const DEFAULT_PANE_PREFERENCES: PanePreferences = {
  version: 1,
  roomSidebarWidth: 280,
};

export const MIN_ROOM_SIDEBAR_WIDTH = 240;
export const MAX_ROOM_SIDEBAR_WIDTH = 360;

export function clampRoomSidebarWidth(width: number): number {
  return Math.min(MAX_ROOM_SIDEBAR_WIDTH, Math.max(MIN_ROOM_SIDEBAR_WIDTH, Math.round(width)));
}
