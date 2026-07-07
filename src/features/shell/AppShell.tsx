import { MessageSquare, Settings as SettingsIcon, Users } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useSettingsNavigation } from "@/features/settings/useSettingsNavigation";
import { useAdaptiveLayout } from "./useAdaptiveLayout";

type MobileTab = "chats" | "people";
export type MobileView = "list" | "detail";

interface AppShellProps {
  /** The rooms rail (`RoomList`) — rendered as the sidebar on desktop, and as the "Chats" tab's list on mobile. */
  roomList: ReactNode;
  /** A direct-messages-only view of the room list — the mobile "People" tab. Desktop has no separate People destination; DMs already live in `roomList`'s sections. */
  peopleList: ReactNode;
  /** The active room's chat view (`ChatShell`). */
  content: ReactNode;
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
 * side) and a mobile bottom-nav layout (Chats / People / Settings tabs, one
 * full-screen view at a time) at the `useAdaptiveLayout` breakpoint — Spec 10.
 * Bottom-nav is Day-1; swipe gestures and haptics are Day-2 (see the spec's
 * non-goals).
 */
export function AppShell({
  roomList,
  peopleList,
  content,
  rightPanel,
  activeRoomId,
  selectionRequestId,
  mobileView,
  onMobileViewChange,
}: AppShellProps) {
  const layout = useAdaptiveLayout();
  const [mobileTab, setMobileTab] = useState<MobileTab>("chats");
  const { openSettings } = useSettingsNavigation();

  useEffect(() => {
    if (activeRoomId) onMobileViewChange("detail");
    // Depends on `selectionRequestId` too, not just `activeRoomId`:
    // re-selecting the already-active room from the list bumps the request
    // id without changing `activeRoomId`, and that reselection must still
    // reopen the detail view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoomId, selectionRequestId]);

  if (layout === "desktop") {
    return (
      <div className="flex h-screen">
        {roomList}
        {content}
        {rightPanel}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="min-h-0 flex-1 overflow-hidden [&>aside]:w-full [&>aside]:border-r-0 [&>div]:w-full [&>div]:border-l-0">
        {mobileView === "detail" && activeRoomId
          ? (rightPanel ?? content)
          : mobileTab === "chats"
            ? roomList
            : peopleList}
      </div>
      <nav className="flex shrink-0 border-t bg-background" aria-label="Primary">
        <button
          type="button"
          aria-current={mobileTab === "chats" && mobileView === "list" ? "page" : undefined}
          className="flex flex-1 flex-col items-center gap-1 py-2 text-xs"
          onClick={() => {
            setMobileTab("chats");
            onMobileViewChange("list");
          }}
        >
          <MessageSquare className="size-5" aria-hidden="true" />
          Chats
        </button>
        <button
          type="button"
          aria-current={mobileTab === "people" && mobileView === "list" ? "page" : undefined}
          className="flex flex-1 flex-col items-center gap-1 py-2 text-xs"
          onClick={() => {
            setMobileTab("people");
            onMobileViewChange("list");
          }}
        >
          <Users className="size-5" aria-hidden="true" />
          People
        </button>
        <button
          type="button"
          className="flex flex-1 flex-col items-center gap-1 py-2 text-xs"
          onClick={() => openSettings("account")}
        >
          <SettingsIcon className="size-5" aria-hidden="true" />
          Settings
        </button>
      </nav>
    </div>
  );
}
