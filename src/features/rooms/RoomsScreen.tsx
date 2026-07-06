import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { RoomList } from "./RoomList";
import { ChatShell } from "./ChatShell";
import { VerificationOverlay } from "@/features/verification/VerificationOverlay";
import { usePresenceListener } from "@/features/presence/usePresence";
import { SettingsScreen } from "@/features/settings/SettingsScreen";
import { listRooms, onRoomListUpdate, resolveRoomAlias, type RoomSummary } from "@/lib/matrix";
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
  // app; consumers (e.g. a DM-aware header/room-list dot) read the atoms
  // directly once DM detection lands — see ChatShell/RoomListItem.
  usePresenceListener();

  useEffect(() => {
    listRooms().then(setRooms).catch(console.error);
    const unlisten = onRoomListUpdate(setRooms);
    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
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
    <div className="flex h-screen">
      <RoomList rooms={rooms} activeRoomId={activeRoomId} onSelectRoom={setActiveRoomId} />
      <ChatShell room={activeRoom} currentUserId={currentUserId} />
      {activeRoom && rightPanelOpen && (
        <RoomInfoPanel
          roomId={activeRoom.room_id}
          currentUserId={currentUserId}
          onClose={() => setRightPanelOpen(false)}
        />
      )}
      <VerificationOverlay />
      <SettingsScreen onLoggedOut={onLoggedOut} />
    </div>
  );
}
