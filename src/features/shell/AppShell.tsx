import { useEffect, useRef, useState, type ReactNode } from "react";
import { useDrag } from "@use-gesture/react";
import { useSettingsNavigation } from "@/features/settings/useSettingsNavigation";
import { useFlag } from "@/featureFlags";
import { useAtomValue } from "jotai";
import { verificationOverlayOpenAtom } from "@/features/verification/verificationAtoms";
import { useAdaptiveLayout } from "./useAdaptiveLayout";
import { ChatVisibilityContext } from "./chatVisibility";
import type { PrimaryDestination } from "./navigationState";
import { PaneResizeHandle } from "./PaneResizeHandle";
import { usePanePreferences } from "./usePanePreferences";
import { MobileBottomNav } from "./MobileBottomNav";
import { cn } from "@/lib/utils";

export type MobileView = "list" | "detail";

interface AppShellProps {
  /** The dedicated spaces rail, shown beside the room list on desktop. */
  spaceRail: ReactNode;
  /** The rooms rail (`RoomList`) — rendered as the sidebar on desktop, and as the "Chats" tab's list on mobile. */
  roomList: ReactNode;
  /** The active room's chat view (`ChatShell`). */
  content: ReactNode;
  /** Whether the Settings destination is currently active in mobile navigation. */
  isSettingsActive?: boolean;
  /** Whether a room-owned modal currently obscures the active chat. */
  chatObscured?: boolean;
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
  primaryDestination?: PrimaryDestination;
  destinationContent?: ReactNode;
  /** Full-width compact Spaces root; the desktop rail remains mounted only on desktop. */
  mobileSpacesContent?: ReactNode;
  onSelectChats?: () => void;
  onSelectActivity?: () => void;
  onSelectSpaces?: () => void;
}

/**
 * Switches between the desktop sidebar layout (rooms rail + content side by
 * side) and a compact, platform-adaptive root with pushed conversation detail,
 * edge-swipe back, and bottom navigation at the `useAdaptiveLayout` breakpoint.
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
  chatObscured = false,
  primaryDestination = "home",
  destinationContent = null,
  mobileSpacesContent = null,
  onSelectChats,
  onSelectActivity,
  onSelectSpaces,
}: AppShellProps) {
  const layout = useAdaptiveLayout();
  const mobileChatRedesignEnabled = useFlag("mobile_chat_redesign");
  const uxRefreshEnabled = useFlag("ux_refresh_v1");
  const mobileChatLayoutEnabled = mobileChatRedesignEnabled || uxRefreshEnabled;
  const verificationOverlayOpen = useAtomValue(verificationOverlayOpenAtom);
  const { openSettings } = useSettingsNavigation();
  const { preferences, setRoomSidebarWidth } = usePanePreferences();
  const contentRef = useRef<HTMLDivElement>(null);
  const [mobileDragX, setMobileDragX] = useState(0);
  const [mobileDragging, setMobileDragging] = useState(false);
  const showingActivity = primaryDestination === "activity";
  const showingMobileSpaces = layout === "mobile" && primaryDestination === "spaces";
  const chatVisible =
    !showingActivity &&
    !showingMobileSpaces &&
    !isSettingsActive &&
    !chatObscured &&
    !verificationOverlayOpen &&
    (layout === "desktop" || (mobileView === "detail" && !!activeRoomId && rightPanel === null));
  const mobileBackGestureEnabled =
    uxRefreshEnabled &&
    layout === "mobile" &&
    mobileView === "detail" &&
    !!activeRoomId &&
    rightPanel === null &&
    !isSettingsActive &&
    !showingActivity;
  const bindMobileBack = useDrag(
    ({
      first,
      last,
      initial: [startX],
      movement: [x, y],
      velocity: [velocityX],
      direction: [xDirection],
      cancel,
    }) => {
      if (!mobileBackGestureEnabled) return;
      if (first && startX > 28) {
        cancel();
        return;
      }
      if (x < 0 || Math.abs(y) > Math.abs(x)) {
        if (last) {
          setMobileDragging(false);
          setMobileDragX(0);
        }
        return;
      }
      const nextX = Math.min(120, x);
      setMobileDragging(!last);
      setMobileDragX(nextX);
      if (!last) return;
      if (nextX >= 72 || (velocityX > 0.35 && xDirection > 0)) {
        onMobileViewChange("list");
      }
      setMobileDragX(0);
    },
    { filterTaps: true, threshold: 4 },
  );

  useEffect(() => {
    if (chatVisible) return;
    // Upload ownership survives navigation, but hidden playback must not.
    contentRef.current?.querySelectorAll<HTMLMediaElement>("audio, video").forEach((media) => {
      media.pause();
    });
  }, [chatVisible]);

  useEffect(() => {
    onMobileViewChange(activeRoomId ? "detail" : "list");
    // Depends on `selectionRequestId` too, not just `activeRoomId`:
    // re-selecting the already-active room from the list bumps the request
    // id without changing `activeRoomId`, and that reselection must still
    // reopen the detail view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoomId, selectionRequestId]);

  return (
    <div
      data-ux-refresh={uxRefreshEnabled ? "true" : undefined}
      className={
        layout === "desktop"
          ? "relative flex h-[100dvh] overflow-hidden bg-background"
          : "flex h-[100dvh] flex-col overflow-hidden bg-background"
      }
    >
      {layout === "desktop" && spaceRail}
      {layout === "desktop" &&
        !showingActivity &&
        (uxRefreshEnabled ? (
          <>
            <div
              className="h-full shrink-0 [&>aside]:h-full [&>aside]:w-full"
              style={{ width: preferences.roomSidebarWidth }}
            >
              {roomList}
            </div>
            <PaneResizeHandle
              width={preferences.roomSidebarWidth}
              onWidthChange={setRoomSidebarWidth}
            />
          </>
        ) : (
          roomList
        ))}
      {/* This keyed owner stays in the same parent across breakpoints so a
          rotation cannot abort admitted attachment or voice uploads. */}
      <div
        key="chat-content"
        ref={contentRef}
        hidden={
          showingActivity ||
          showingMobileSpaces ||
          (layout === "mobile" && (mobileView !== "detail" || !activeRoomId || rightPanel !== null))
        }
        className={cn(
          layout === "desktop"
            ? uxRefreshEnabled
              ? "flex min-w-0 flex-1 [&>div]:min-w-0"
              : "contents"
            : "h-full min-h-0 flex-1 overflow-hidden pt-[env(safe-area-inset-top)] will-change-transform [&>div]:h-full [&>div]:w-full [&>div]:border-l-0",
          layout === "mobile" && !mobileDragging && "transition-transform duration-150",
        )}
        style={{
          transform: mobileDragX > 0 ? `translateX(${mobileDragX}px)` : undefined,
          touchAction: mobileBackGestureEnabled ? "pan-y" : undefined,
        }}
        {...(mobileBackGestureEnabled ? bindMobileBack() : {})}
      >
        <ChatVisibilityContext.Provider value={chatVisible}>
          {content}
        </ChatVisibilityContext.Provider>
      </div>
      {layout === "desktop" && showingActivity && destinationContent}
      {layout === "desktop" &&
        !showingActivity &&
        rightPanel &&
        (uxRefreshEnabled ? (
          <div className="z-30 h-full shrink-0 shadow-[-18px_0_45px_rgba(0,0,0,0.18)] max-xl:absolute max-xl:inset-y-0 max-xl:right-0 xl:shadow-none [&>div]:h-full">
            {rightPanel}
          </div>
        ) : (
          rightPanel
        ))}
      {layout === "mobile" &&
        (showingActivity ? (
          destinationContent
        ) : showingMobileSpaces ? (
          mobileSpacesContent
        ) : mobileView === "detail" && activeRoomId ? (
          rightPanel && (
            <div className="min-h-0 flex-1 overflow-hidden pt-[env(safe-area-inset-top)] [&>div]:h-full [&>div]:w-full [&>div]:border-l-0">
              {rightPanel}
            </div>
          )
        ) : (
          <div
            className={cn(
              "flex min-h-0 flex-1 pt-[env(safe-area-inset-top)]",
              uxRefreshEnabled
                ? "[&>aside]:w-full [&>aside]:border-r-0"
                : "[&>aside:first-child]:w-[72px] [&>aside:last-child]:w-[calc(100%-72px)] [&>aside:last-child]:shrink [&>aside:last-child]:border-r-0",
            )}
          >
            {!uxRefreshEnabled && spaceRail}
            {roomList}
          </div>
        ))}
      {layout === "mobile" &&
        (uxRefreshEnabled ||
          showingActivity ||
          !mobileChatLayoutEnabled ||
          mobileView === "list" ||
          !activeRoomId) && (
          <MobileBottomNav
            refresh={uxRefreshEnabled}
            chatsActive={
              uxRefreshEnabled
                ? !showingActivity && !showingMobileSpaces && !isSettingsActive
                : mobileView === "list" && !isSettingsActive
            }
            activityActive={showingActivity}
            spacesActive={showingMobileSpaces}
            settingsActive={isSettingsActive}
            showActivity={uxRefreshEnabled && !!onSelectActivity}
            showSpaces={uxRefreshEnabled && !!onSelectSpaces}
            onSelectChats={() => {
              onSelectChats?.();
              onMobileViewChange("list");
            }}
            onSelectActivity={onSelectActivity}
            onSelectSpaces={onSelectSpaces}
            onSelectSettings={() => openSettings("account")}
          />
        )}
    </div>
  );
}
