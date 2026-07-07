import { useEffect, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { RoomList } from "./RoomList";
import { ChatShell } from "./ChatShell";
import { VerificationOverlay } from "@/features/verification/VerificationOverlay";
import { usePresenceListener } from "@/features/presence/usePresence";
import { SettingsScreen } from "@/features/settings/SettingsScreen";
import { settingsOpenAtom } from "@/features/settings/settingsAtoms";
import { AppShell } from "@/features/shell/AppShell";
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
  useEffect(() => {
    function syncFocusedRoom() {
      const isShowingChat = !settingsSection && document.hasFocus();
      setFocusedRoom(isShowingChat ? activeRoomId : null).catch(console.error);
    }
    syncFocusedRoom();
    window.addEventListener("focus", syncFocusedRoom);
    window.addEventListener("blur", syncFocusedRoom);
    return () => {
      window.removeEventListener("focus", syncFocusedRoom);
      window.removeEventListener("blur", syncFocusedRoom);
    };
  }, [activeRoomId, settingsSection]);

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
      setActiveRoomId(match.room_id);
      setResolvedDeepLinkTarget(null);
      onDeepLinkConsumed();
    }
  }, [resolvedDeepLinkTarget, rooms, onDeepLinkConsumed]);

  useEffect(() => {
    if (deepLinkRoomId) return; // let a pending deep link win the initial selection
    if (activeRoomId === null && rooms.length > 0) {
      setActiveRoomId(rooms[0].room_id);
    }
  }, [rooms, activeRoomId, deepLinkRoomId]);

  const activeRoom = rooms.find((room) => room.room_id === activeRoomId) ?? null;
  const [rightPanelOpen, setRightPanelOpen] = useAtom(
    rightPanelOpenAtomFamily(activeRoom?.room_id ?? ""),
  );

  // Bumped on every room selection, even re-selecting the already-active
  // room — `activeRoomId` alone wouldn't change in that case, so on mobile
  // `AppShell` couldn't tell "reopen the detail view" apart from "nothing
  // happened" when tapping the current room again from the list.
  const [selectionRequestId, setSelectionRequestId] = useState(0);
  function handleSelectRoom(roomId: string) {
    setActiveRoomId(roomId);
    setSelectionRequestId((n) => n + 1);
  }

  return (
    <>
      <AppShell
        activeRoomId={activeRoomId}
        selectionRequestId={selectionRequestId}
        roomList={
          <RoomList rooms={rooms} activeRoomId={activeRoomId} onSelectRoom={handleSelectRoom} />
        }
        peopleList={
          <RoomList
            rooms={rooms.filter((room) => room.is_direct)}
            activeRoomId={activeRoomId}
            onSelectRoom={handleSelectRoom}
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
