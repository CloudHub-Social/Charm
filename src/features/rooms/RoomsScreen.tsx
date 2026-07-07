import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { RoomList } from "./RoomList";
import { ChatShell } from "./ChatShell";
import { VerificationOverlay } from "@/features/verification/VerificationOverlay";
import { usePresenceListener } from "@/features/presence/usePresence";
import { SettingsScreen } from "@/features/settings/SettingsScreen";
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
  // notification for whatever the user is already looking at (Spec 10). No
  // cleanup on this effect: React runs an effect's cleanup before re-running
  // it on every dependency change, and clearing focus to `null` there would
  // open a brief "nothing focused" window on every room switch during which
  // a notification for the room being switched away from could slip through.
  useEffect(() => {
    setFocusedRoom(activeRoomId).catch(console.error);
  }, [activeRoomId]);

  // Clears focus only on unmount (e.g. sign-out) so a stale focused room
  // never survives past this screen — separate from the effect above so
  // this doesn't fire on every `activeRoomId` change.
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

  return (
    <>
      <AppShell
        activeRoomId={activeRoomId}
        roomList={
          <RoomList rooms={rooms} activeRoomId={activeRoomId} onSelectRoom={setActiveRoomId} />
        }
        peopleList={
          <RoomList
            rooms={rooms.filter((room) => room.is_direct)}
            activeRoomId={activeRoomId}
            onSelectRoom={setActiveRoomId}
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
