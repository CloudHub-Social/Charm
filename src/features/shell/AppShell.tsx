import { MessageSquare, Settings as SettingsIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { useSettingsNavigation } from "@/features/settings/useSettingsNavigation";
import { useFlag } from "@/featureFlags";
import { useAdaptiveLayout } from "./useAdaptiveLayout";

export type MobileView = "list" | "detail";

interface AppShellProps {
  /** The dedicated spaces rail, shown beside the room list on desktop and mobile list views. */
  spaceRail: ReactNode;
  /** The rooms rail (`RoomList`) — rendered as the sidebar on desktop, and as the "Chats" tab's list on mobile. */
  roomList: ReactNode;
  /** The active room's chat view (`ChatShell`). */
  content: ReactNode;
  /** Whether the Settings destination is currently active in mobile navigation. */
  isSettingsActive?: boolean;
  /** The right-hand room-info panel, or `null` when closed — desktop-only; not shown on mobile (Day-2 per the spec's non-goals). */
  rightPanel: ReactNode | null;
  /** The currently selected room id, or `null` — drives the mobile list-vs-detail view. */
  activeRoomId: string | null;
  /** Bumped by the caller on every room selection, including re-selecting the already-active room — `activeRoomId` alone can't distinguish "reopen the detail view for this room" from "nothing happened" when the id doesn't change. */
  selectionRequestId: number;
  /**
   * Controlled by the caller (`RoomsScreen`), not owned here — its focus-
   * tracking effect needs to know whether the chat is actually visible on
   * mobile (only true in `"detail"`) to decide whether the active room
   * should read as focused for local-notification suppression.
   */
  mobileView: MobileView;
  onMobileViewChange: (view: MobileView) => void;
}

/**
 * Switches between the desktop sidebar layout (rooms rail + content side by
 * side) and a mobile bottom navigation with Chats and Settings destinations at
 * the `useAdaptiveLayout` breakpoint — Spec 10.
 * Bottom-nav is Day-1; swipe gestures and haptics are Day-2 (see the spec's
 * non-goals).
 */
export function AppShell({
  spaceRail,
  roomList,
  content,
  rightPanel,
  activeRoomId,
  selectionRequestId,
  mobileView,
  onMobileViewChange,
  isSettingsActive = false,
}: AppShellProps) {
  const layout = useAdaptiveLayout();
  const mobileChatRedesignEnabled = useFlag("mobile_chat_redesign");
  const { openSettings } = useSettingsNavigation();

  useEffect(() => {
    onMobileViewChange(activeRoomId ? "detail" : "list");
    // Depends on `selectionRequestId` too, not just `activeRoomId`:
    // re-selecting the already-active room from the list bumps the request
    // id without changing `activeRoomId`, and that reselection must still
    // reopen the detail view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoomId, selectionRequestId]);

  if (layout === "desktop") {
    return (
      <div className="flex h-[100dvh]">
        {spaceRail}
        {roomList}
        {content}
        {rightPanel}
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] flex-col">
      <div className="min-h-0 flex-1 overflow-hidden pt-[env(safe-area-inset-top)] [&>div]:h-full [&>div]:w-full [&>div]:border-l-0">
        {mobileView === "detail" && activeRoomId ? (
          (rightPanel ?? content)
        ) : (
          <div className="flex h-full min-w-0 [&>aside:first-child]:w-[72px] [&>aside:last-child]:w-[calc(100%-72px)] [&>aside:last-child]:shrink [&>aside:last-child]:border-r-0">
            {spaceRail}
            {roomList}
          </div>
        )}
      </div>
      {(!mobileChatRedesignEnabled || mobileView === "list" || !activeRoomId) && (
        <nav
          className="flex shrink-0 border-t bg-background pb-[env(safe-area-inset-bottom)]"
          aria-label="Primary"
        >
          <button
            type="button"
            aria-current={mobileView === "list" && !isSettingsActive ? "page" : undefined}
            className="flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 py-1 text-xs"
            onClick={() => onMobileViewChange("list")}
          >
            <MessageSquare className="size-5" aria-hidden="true" />
            Chats
          </button>
          <button
            type="button"
            aria-current={isSettingsActive ? "page" : undefined}
            className="flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 py-1 text-xs"
            onClick={() => openSettings("account")}
          >
            <SettingsIcon className="size-5" aria-hidden="true" />
            Settings
          </button>
        </nav>
      )}
    </div>
  );
}
