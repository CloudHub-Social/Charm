import { useEffect, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { RoomList } from "./RoomList";
import { ChatShell } from "./ChatShell";
import { VerificationOverlay } from "@/features/verification/VerificationOverlay";
import { usePresenceListener } from "@/features/presence/usePresence";
import { SettingsScreen } from "@/features/settings/SettingsScreen";
import { settingsOpenAtom } from "@/features/settings/settingsAtoms";
import { AppShell, type MobileView } from "@/features/shell/AppShell";
import { useAdaptiveLayout } from "@/features/shell/useAdaptiveLayout";
import { useBadgeListener } from "@/features/shell/useBadgeListener";
import {
  listRooms,
  onRoomListUpdate,
  resolveRoomAlias,
  setFocusedRoom,
  type RoomSummary,
} from "@/lib/matrix";
import { RoomInfoPanel } from "@/features/room-info/RoomInfoPanel";
import { rightPanelOpenAtomFamily } from "@/features/room-info/roomInfoAtoms";

interface RoomsScreenProps {
  currentUserId: string;
  deepLinkRoomId: string | null;
  onDeepLinkConsumed: () => void;
  onLoggedOut: () => void;
}

export function RoomsScreen({
  currentUserId,
  deepLinkRoomId,
  onDeepLinkConsumed,
  onLoggedOut,
}: RoomsScreenProps) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [resolvedDeepLinkTarget, setResolvedDeepLinkTarget] = useState<string | null>(null);

  // Bumped on every room selection — via the room list, a deep link, or the
  // initial auto-select — even when it re-selects the already-active room.
  // `activeRoomId` alone can't signal that: on mobile, `AppShell` needs to
  // tell "open/reopen the detail view for this room" apart from "nothing
  // happened" when the id doesn't change (e.g. a `charm://room/<id>` deep
  // link for the room already selected while a list tab is showing).
  const [selectionRequestId, setSelectionRequestId] = useState(0);
  function selectRoom(roomId: string) {
    setActiveRoomId(roomId);
    setSelectionRequestId((n) => n + 1);
  }

  // Feeds `presenceAtomFamily` from `presence:update` pushes for the whole
  // app; consumers (the DM header/room-list presence dot) read the atoms
  // directly via `usePresence` — see ChatShell/RoomListItem.
  usePresenceListener();
  useBadgeListener();

  useEffect(() => {
    listRooms().then(setRooms).catch(console.error);
    const unlisten = onRoomListUpdate(setRooms);
    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
    };
  }, []);

  // Tells the Rust side which room has focus so it can suppress a local
  // notification for whatever the user is already looking at (Spec 10). Not
  // just a function of `activeRoomId`: the active room isn't actually
  // "focused" while the settings overlay covers the chat, or while the OS
  // window itself is blurred/minimized — in either case the room should read
  // as unfocused so a background notification for it still fires. Re-synced
  // (not just set once) on window focus/blur so switching back to the app
  // restores tracking without needing `activeRoomId` to change.
  const settingsSection = useAtomValue(settingsOpenAtom);
  const layout = useAdaptiveLayout();
  // On mobile, the active room is only actually on-screen while `AppShell`
  // is showing its detail view — the Chats/People tabs show a list instead,
  // with the "active" room still selected but not visible. Without this,
  // switching to the list on mobile left the selected room reporting as
  // focused (window still has OS focus, settings still closed), suppressing
  // its notifications even though nothing but the room list is showing.
  const [mobileView, setMobileView] = useState<MobileView>("list");
  useEffect(() => {
    function syncFocusedRoom() {
      const isShowingChat =
        !settingsSection &&
        document.hasFocus() &&
        (layout === "desktop" || mobileView === "detail");
      setFocusedRoom(isShowingChat ? activeRoomId : null).catch(console.error);
    }
    syncFocusedRoom();
    window.addEventListener("focus", syncFocusedRoom);
    window.addEventListener("blur", syncFocusedRoom);
    return () => {
      window.removeEventListener("focus", syncFocusedRoom);
      window.removeEventListener("blur", syncFocusedRoom);
    };
  }, [activeRoomId, settingsSection, layout, mobileView]);

  // Clears focus only on unmount (e.g. sign-out) so a stale focused room
  // never survives past this screen — separate from the effect above so
  // this doesn't fire on every `activeRoomId`/`settingsSection` change.
  useEffect(() => {
    return () => {
      setFocusedRoom(null).catch(console.error);
    };
  }, []);

  useEffect(() => {
    // Resolve once per new deep-link target, independent of room-list churn —
    // room aliases (#alias:server) need a network round-trip, raw room ids
    // (!id:server, our own charm://room/<id> links) don't.
    if (!deepLinkRoomId) return;
    if (!deepLinkRoomId.startsWith("#")) {
      setResolvedDeepLinkTarget(deepLinkRoomId);
      return;
    }
    resolveRoomAlias(deepLinkRoomId)
      .then(setResolvedDeepLinkTarget)
      .catch((err) => {
        console.error(`Failed to resolve room alias ${deepLinkRoomId}:`, err);
      });
  }, [deepLinkRoomId]);

  useEffect(() => {
    if (!resolvedDeepLinkTarget) return;
    const match = rooms.find((room) => room.room_id === resolvedDeepLinkTarget);
    if (match) {
      // `selectRoom`, not a plain `setActiveRoomId`: a deep link targeting
      // the room that's already active (e.g. re-tapping the same
      // `charm://room/<id>` link while mobile is showing a list tab) must
      // still bump `selectionRequestId` so the mobile detail view actually
      // opens, not just silently consume the link.
      selectRoom(match.room_id);
      setResolvedDeepLinkTarget(null);
      onDeepLinkConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedDeepLinkTarget, rooms, onDeepLinkConsumed]);

  useEffect(() => {
    if (deepLinkRoomId) return; // let a pending deep link win the initial selection
    if (activeRoomId === null && rooms.length > 0) {
      selectRoom(rooms[0].room_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms, activeRoomId, deepLinkRoomId]);

  const activeRoom = rooms.find((room) => room.room_id === activeRoomId) ?? null;
  const [rightPanelOpen, setRightPanelOpen] = useAtom(
    rightPanelOpenAtomFamily(activeRoom?.room_id ?? ""),
  );

  // The right panel is desktop-only (mobile has no room besides the active
  // one to show it alongside — see `AppShell`'s non-goals). Reset only on
  // the desktop -> mobile *transition* (tracked via `prevLayoutRef`), not
  // whenever `rightPanelOpen` is true while already mobile — the latter
  // would fire every time the panel opens on mobile (via `ChatShell`'s
  // "Show room info" button) and immediately close it again before it's
  // ever visible, defeating mobile's own ability to show it. The transition
  // check still catches opening it on desktop and then narrowing the
  // window, which would otherwise leave `rightPanelOpen` stuck `true` and
  // the mobile detail view showing a panel for a layout it was never opened
  // in.
  const prevLayoutRef = useRef(layout);
  useEffect(() => {
    if (prevLayoutRef.current === "desktop" && layout === "mobile" && rightPanelOpen) {
      setRightPanelOpen(false);
    }
    prevLayoutRef.current = layout;
  }, [layout, rightPanelOpen, setRightPanelOpen]);

  return (
    <>
      <AppShell
        activeRoomId={activeRoomId}
        selectionRequestId={selectionRequestId}
        mobileView={mobileView}
        onMobileViewChange={setMobileView}
        roomList={<RoomList rooms={rooms} activeRoomId={activeRoomId} onSelectRoom={selectRoom} />}
        peopleList={
          <RoomList
            rooms={rooms.filter((room) => room.is_direct)}
            activeRoomId={activeRoomId}
            onSelectRoom={selectRoom}
          />
        }
        content={<ChatShell room={activeRoom} currentUserId={currentUserId} />}
        rightPanel={
          activeRoom && rightPanelOpen ? (
            <RoomInfoPanel
              roomId={activeRoom.room_id}
              currentUserId={currentUserId}
              onClose={() => setRightPanelOpen(false)}
            />
          ) : null
        }
      />
      <VerificationOverlay />
      <SettingsScreen onLoggedOut={onLoggedOut} />
    </>
  );
}
