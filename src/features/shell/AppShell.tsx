import { MessageSquare, Settings as SettingsIcon, Users } from "lucide-react";
import { useSetAtom } from "jotai";
import { useEffect, useState, type ReactNode } from "react";
import { settingsOpenAtom } from "@/features/settings/settingsAtoms";
import { useAdaptiveLayout } from "./useAdaptiveLayout";

type MobileTab = "chats" | "people";
type MobileView = "list" | "detail";

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
}: AppShellProps) {
  const layout = useAdaptiveLayout();
  const [mobileTab, setMobileTab] = useState<MobileTab>("chats");
  const [mobileView, setMobileView] = useState<MobileView>("list");
  const setSettingsOpen = useSetAtom(settingsOpenAtom);

  useEffect(() => {
    if (activeRoomId) setMobileView("detail");
  }, [activeRoomId]);

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
      <div className="min-h-0 flex-1 overflow-hidden">
        {mobileView === "detail" && activeRoomId
          ? content
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
            setMobileView("list");
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
            setMobileView("list");
          }}
        >
          <Users className="size-5" aria-hidden="true" />
          People
        </button>
        <button
          type="button"
          className="flex flex-1 flex-col items-center gap-1 py-2 text-xs"
          onClick={() => setSettingsOpen("account")}
        >
          <SettingsIcon className="size-5" aria-hidden="true" />
          Settings
        </button>
      </nav>
    </div>
  );
}
