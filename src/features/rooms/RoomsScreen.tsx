import { useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { RoomList } from "./RoomList";
import { SpaceRail, type RoomListMode } from "./SpaceRail";
import { CreateJoinSpaceDialog } from "./CreateJoinSpaceDialog";
import { ChatShell } from "./ChatShell";
import { VerificationOverlay } from "@/features/verification/VerificationOverlay";
import { usePresenceListener } from "@/features/presence/usePresence";
import { SettingsScreen } from "@/features/settings/SettingsScreen";
import { settingsOpenAtom } from "@/features/settings/settingsAtoms";
import {
  useSettingsHashSync,
  useSettingsNavigation,
} from "@/features/settings/useSettingsNavigation";
import { CrashRecoveryPrompt } from "@/observability/CrashRecoveryPrompt";
import { AppShell, type MobileView } from "@/features/shell/AppShell";
import { useAdaptiveLayout } from "@/features/shell/useAdaptiveLayout";
import { useBadgeListener } from "@/features/shell/useBadgeListener";
import {
  acceptInvite,
  declineInvite,
  listRooms,
  onRoomListUpdate,
  resolveRoomAlias,
  setFocusedRoom,
  type RoomSummary,
} from "@/lib/matrix";
import { MembersDrawer } from "@/features/room-info/MembersDrawer";
import { RoomSettingsModal } from "@/features/room-info/RoomSettingsModal";
import {
  membersDrawerOpenAtomFamily,
  noRoomMembersDrawerOpenAtom,
  roomSettingsAtom,
} from "@/features/room-info/roomInfoAtoms";
import { useRoomDetails } from "@/features/room-info/useRoomDetails";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { useFlag } from "@/featureFlags";

const noopDismissCrashRecoveryPrompt = () => {};

interface RoomsScreenProps {
  currentUserId: string;
  deepLinkRoomId: string | null;
  onDeepLinkConsumed: () => void;
  onLoggedOut: () => void;
  /**
   * Whether to show `main.tsx`'s crash-recovery prompt right now. Controlled
   * from `App` (not owned as local state here) — `RoomsScreen` unmounts on
   * logout and remounts on the next sign-in within the same app process, so
   * state initialized from a prop here would forget a dismissal and could
   * reappear after a logout/login cycle. `App` doesn't unmount across that
   * flow, so its state survives. Rendered from here rather than `App`
   * directly (or `main.tsx`'s top-level `Root`) because this is the first
   * point in the component tree where `SettingsScreen`/`useSettingsHashSync`
   * are actually mounted — shown any earlier, the prompt's "Review crash
   * reporting settings" button would change the URL hash with nothing
   * listening for it yet — see PR #228 review discussion.
   */
  crashRecoveryPromptOpen?: boolean;
  onDismissCrashRecoveryPrompt?: () => void;
}

export function RoomsScreen({
  currentUserId,
  deepLinkRoomId,
  onDeepLinkConsumed,
  onLoggedOut,
  crashRecoveryPromptOpen = false,
  onDismissCrashRecoveryPrompt = noopDismissCrashRecoveryPrompt,
}: RoomsScreenProps) {
  const { openSettings } = useSettingsNavigation();
  const roomInvitesEnabled = useFlag("room_invites");
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [roomsLoaded, setRoomsLoaded] = useState(false);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [roomListMode, setRoomListMode] = useState<RoomListMode>("home");
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const [showAllRooms, setShowAllRooms] = useState(false);
  const [createJoinDialogOpen, setCreateJoinDialogOpen] = useState(false);
  const [resolvedDeepLinkTarget, setResolvedDeepLinkTarget] = useState<string | null>(null);
  const [acceptedRoomPendingSelection, setAcceptedRoomPendingSelection] = useState<string | null>(
    null,
  );
  const autoSelectSuppressedRef = useRef<
    { kind: "space" } | { kind: "invite"; roomId: string } | null
  >(null);

  // Bumped on every room selection — via the room list, a deep link, or the
  // initial auto-select — even when it re-selects the already-active room.
  // `activeRoomId` alone can't signal that: on mobile, `AppShell` needs to
  // tell "open/reopen the detail view for this room" apart from "nothing
  // happened" when the id doesn't change (e.g. a `charm://room/<id>` deep
  // link for the room already selected while a list tab is showing).
  const [selectionRequestId, setSelectionRequestId] = useState(0);
  function selectRoom(roomId: string) {
    autoSelectSuppressedRef.current = null;
    setActiveRoomId(roomId);
    setSelectionRequestId((n) => n + 1);
  }

  function selectHome() {
    autoSelectSuppressedRef.current = null;
    setRoomListMode("home");
    setSelectedSpaceId(null);
  }

  function selectDms() {
    autoSelectSuppressedRef.current = null;
    setRoomListMode("dms");
    setSelectedSpaceId(null);
  }

  function selectSpace(spaceId: string) {
    autoSelectSuppressedRef.current = null;
    setRoomListMode("space");
    setSelectedSpaceId(spaceId);
  }

  // Selecting a space right after creating/joining it from the dialog can
  // land with `activeRoomId` still `null` (e.g. the dialog was opened while
  // no chat was active, such as right after a space deep link). `selectSpace`
  // alone would leave that window open for the auto-select effect below to
  // fire on the next sync-driven room-list update and switch back to the
  // first non-space room — reusing `autoSelectSuppressedRef` (the same guard
  // the deep-link flow sets) suppresses that fallback the same way.
  function selectNewlyCreatedOrJoinedSpace(spaceId: string) {
    selectSpace(spaceId);
    autoSelectSuppressedRef.current = { kind: "space" };
  }

  function selectRoomInVisibleMode(room: RoomSummary, visibleRooms = joinedRooms) {
    if (room.is_space) {
      selectSpace(room.room_id);
      setActiveRoomId(null);
      setMobileView("list");
      return;
    }
    if (room.is_direct) {
      selectDms();
    } else if (room.parent_space_ids.length > 0) {
      const joinedParentSpaceIds = room.parent_space_ids
        .filter((spaceId) =>
          visibleRooms.some((candidate) => candidate.room_id === spaceId && candidate.is_space),
        )
        .toSorted();
      const parentSpaceId = joinedParentSpaceIds[0];
      if (parentSpaceId) {
        selectSpace(parentSpaceId);
      } else {
        setRoomListMode("home");
        setSelectedSpaceId(null);
        setShowAllRooms(true);
      }
    } else {
      selectHome();
    }
    selectRoom(room.room_id);
  }

  // Feeds `presenceAtomFamily` from `presence:update` pushes for the whole
  // app; consumers (the DM header/room-list presence dot) read the atoms
  // directly via `usePresence` — see ChatShell/RoomListItem.
  usePresenceListener();
  useBadgeListener();
  useSettingsHashSync();

  const joinedRooms = useMemo(() => rooms.filter((room) => room.membership === "join"), [rooms]);

  useEffect(() => {
    listRooms()
      .then((nextRooms) => {
        setRooms(nextRooms);
        setRoomsLoaded(true);
      })
      .catch(logAndIgnore);
    const unlisten = onRoomListUpdate((nextRooms) => {
      setRooms(nextRooms);
      setRoomsLoaded(true);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(logAndIgnore);
    };
  }, []);

  async function refreshRooms() {
    const nextRooms = await listRooms();
    setRooms(nextRooms);
    return nextRooms;
  }

  async function handleAcceptInvite(roomId: string) {
    await acceptInvite(roomId);
    // Joining completes on the homeserver before matrix-sdk's local room
    // state necessarily advances to `Joined`. Remember the navigation intent
    // across that gap; the effect below handles either this fast-path refresh
    // or the next background `room_list:update` snapshot.
    setAcceptedRoomPendingSelection(roomId);
    await refreshRooms();
  }

  useEffect(() => {
    if (!acceptedRoomPendingSelection) return;
    const joinedRoom = rooms.find(
      (room) => room.room_id === acceptedRoomPendingSelection && room.membership === "join",
    );
    if (!joinedRoom) return;
    selectRoomInVisibleMode(joinedRoom, joinedRooms);
    setAcceptedRoomPendingSelection(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptedRoomPendingSelection, rooms, joinedRooms]);

  async function handleDeclineInvite(roomId: string) {
    await declineInvite(roomId);
    // A deep link to an invite deliberately suppresses the normal initial
    // room selection while that invite is actionable. Once it is declined,
    // release the guard before publishing the refreshed snapshot so the
    // first joined room can fill the otherwise-empty detail pane.
    if (
      autoSelectSuppressedRef.current?.kind === "invite" &&
      autoSelectSuppressedRef.current.roomId === roomId
    ) {
      autoSelectSuppressedRef.current = null;
    }
    await refreshRooms();
  }

  // Tells the Rust side which room has focus so it can suppress a local
  // notification for whatever the user is already looking at (Spec 10). Not
  // just a function of `activeRoomId`: the active room isn't actually
  // "focused" while the settings overlay or the room settings modal covers
  // the chat, or while the OS window itself is blurred/minimized — in any of
  // those cases the room should read as unfocused so a background
  // notification for it still fires. Re-synced (not just set once) on window
  // focus/blur so switching back to the app restores tracking without
  // needing `activeRoomId` to change.
  const settingsSection = useAtomValue(settingsOpenAtom);
  const roomSettingsTarget = useAtomValue(roomSettingsAtom);
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
        !roomSettingsTarget &&
        document.hasFocus() &&
        (layout === "desktop" || mobileView === "detail");
      setFocusedRoom(isShowingChat ? activeRoomId : null).catch(logAndIgnore);
    }
    syncFocusedRoom();
    window.addEventListener("focus", syncFocusedRoom);
    window.addEventListener("blur", syncFocusedRoom);
    return () => {
      window.removeEventListener("focus", syncFocusedRoom);
      window.removeEventListener("blur", syncFocusedRoom);
    };
  }, [activeRoomId, settingsSection, roomSettingsTarget, layout, mobileView]);

  // Clears focus only on unmount (e.g. sign-out) so a stale focused room
  // never survives past this screen — separate from the effect above so
  // this doesn't fire on every `activeRoomId`/`settingsSection` change.
  useEffect(() => {
    return () => {
      setFocusedRoom(null).catch(logAndIgnore);
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
    if (!resolvedDeepLinkTarget || !roomsLoaded) return;
    const match = rooms.find((room) => room.room_id === resolvedDeepLinkTarget);
    if (match?.membership === "join") {
      // `selectRoom`, not a plain `setActiveRoomId`: a deep link targeting
      // the room that's already active (e.g. re-tapping the same
      // `charm://room/<id>` link while mobile is showing a list tab) must
      // still bump `selectionRequestId` so the mobile detail view actually
      // opens, not just silently consume the link.
      selectRoomInVisibleMode(match);
      if (match.is_space) {
        autoSelectSuppressedRef.current = { kind: "space" };
      }
    } else if (match?.membership === "invite" && roomInvitesEnabled) {
      // Invites are actionable from the room-list inbox, not selectable as
      // timelines. Bring that inbox into view and consume the deep link so
      // it cannot block normal room selection indefinitely.
      setRoomListMode("home");
      setSelectedSpaceId(null);
      setMobileView("list");
      autoSelectSuppressedRef.current = { kind: "invite", roomId: match.room_id };
    }
    // A resolved target absent from the completed snapshot is stale or not
    // visible to this account. Consume it rather than letting it suppress
    // initial room selection forever.
    setResolvedDeepLinkTarget(null);
    onDeepLinkConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedDeepLinkTarget, rooms, roomsLoaded, onDeepLinkConsumed, roomInvitesEnabled]);

  useEffect(() => {
    const suppression = autoSelectSuppressedRef.current;
    if (suppression?.kind !== "invite" || !roomsLoaded) return;
    const inviteStillPending = rooms.some(
      (room) => room.room_id === suppression.roomId && room.membership === "invite",
    );
    if (!inviteStillPending) {
      // The invite may have been declined locally, accepted, or revoked by
      // the inviter. Only release invite-owned suppression here; a deliberate
      // no-room space selection must remain stable across unrelated updates.
      autoSelectSuppressedRef.current = null;
    }
  }, [rooms, roomsLoaded]);

  useEffect(() => {
    if (deepLinkRoomId) return; // let a pending deep link win the initial selection
    if (acceptedRoomPendingSelection) return; // let explicit post-accept navigation win
    const firstSelectableRoom = getInitialSelectableRoom(joinedRooms);
    if (activeRoomId === null && firstSelectableRoom) {
      if (autoSelectSuppressedRef.current) return;
      selectRoomInVisibleMode(firstSelectableRoom);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinedRooms, activeRoomId, deepLinkRoomId, acceptedRoomPendingSelection]);

  const activeRoom = joinedRooms.find((room) => room.room_id === activeRoomId) ?? null;
  const selectedSpace =
    roomListMode === "space"
      ? (joinedRooms.find((room) => room.room_id === selectedSpaceId && room.is_space) ?? null)
      : null;
  // Keeps `useRoomDetails`' `room_details:update` listener alive for the
  // active room regardless of whether `RoomSettingsModal`/`MembersDrawer`
  // are open — those now mount `useRoomDetails` independently and only
  // while visible, so without this always-on subscription here a remote
  // membership change while both are closed would go un-invalidated,
  // leaving `useRoomMembers`' cache stale until it naturally expires.
  useRoomDetails(activeRoom?.room_id ?? null);
  const [membersDrawerOpen, setMembersDrawerOpen] = useAtom(
    activeRoom ? membersDrawerOpenAtomFamily(activeRoom.room_id) : noRoomMembersDrawerOpenAtom,
  );

  // The members drawer is desktop-only (mobile has no room besides the
  // active one to show it alongside — see `AppShell`'s non-goals). Reset
  // only on the desktop -> mobile *transition* (tracked via
  // `prevLayoutRef`), not whenever `membersDrawerOpen` is true while already
  // mobile — the latter would fire every time the drawer opens on mobile
  // (via `ChatShell`'s "Show members" button) and immediately close it again
  // before it's ever visible, defeating mobile's own ability to show it. The
  // transition check still catches opening it on desktop and then narrowing
  // the window, which would otherwise leave `membersDrawerOpen` stuck `true`
  // and the mobile detail view showing a panel for a layout it was never
  // opened in.
  const prevLayoutRef = useRef(layout);
  useEffect(() => {
    if (prevLayoutRef.current === "desktop" && layout === "mobile" && membersDrawerOpen) {
      setMembersDrawerOpen(false);
    }
    prevLayoutRef.current = layout;
  }, [layout, membersDrawerOpen, setMembersDrawerOpen]);

  return (
    <>
      <AppShell
        spaceRail={
          <SpaceRail
            rooms={joinedRooms}
            activeMode={roomListMode}
            activeSpaceId={selectedSpaceId}
            showAllRooms={showAllRooms}
            onSelectHome={selectHome}
            onSelectDms={selectDms}
            onSelectSpace={selectSpace}
            onCreateJoin={() => setCreateJoinDialogOpen(true)}
          />
        }
        activeRoomId={activeRoomId}
        selectionRequestId={selectionRequestId}
        mobileView={mobileView}
        onMobileViewChange={setMobileView}
        isSettingsActive={settingsSection !== null}
        roomList={
          <RoomList
            rooms={roomInvitesEnabled ? rooms : joinedRooms}
            activeRoomId={activeRoomId}
            onSelectRoom={selectRoom}
            onSelectSpace={selectSpace}
            onSelectSearchResult={selectRoomInVisibleMode}
            mode={roomListMode}
            selectedSpace={selectedSpace}
            intendedSpaceId={roomListMode === "space" ? selectedSpaceId : null}
            showAllRooms={showAllRooms}
            onShowAllRoomsChange={setShowAllRooms}
            onAcceptInvite={handleAcceptInvite}
            onDeclineInvite={handleDeclineInvite}
          />
        }
        content={<ChatShell room={activeRoom} currentUserId={currentUserId} />}
        rightPanel={
          activeRoom && membersDrawerOpen ? (
            <MembersDrawer
              roomId={activeRoom.room_id}
              currentUserId={currentUserId}
              onClose={() => setMembersDrawerOpen(false)}
            />
          ) : null
        }
      />
      <CreateJoinSpaceDialog
        open={createJoinDialogOpen}
        onOpenChange={setCreateJoinDialogOpen}
        onSpaceCreated={(spaceId) => selectNewlyCreatedOrJoinedSpace(spaceId)}
        onSpaceJoined={(spaceId) => selectNewlyCreatedOrJoinedSpace(spaceId)}
      />
      <RoomSettingsModal currentUserId={currentUserId} />
      <VerificationOverlay />
      <SettingsScreen onLoggedOut={onLoggedOut} />
      <CrashRecoveryPrompt
        open={crashRecoveryPromptOpen}
        onDismiss={onDismissCrashRecoveryPrompt}
        onOpenSettings={() => {
          onDismissCrashRecoveryPrompt();
          openSettings("observability");
        }}
      />
    </>
  );
}

function getInitialSelectableRoom(rooms: RoomSummary[]) {
  return getInitialHomeRoom(rooms) ?? rooms.find((room) => !room.is_space);
}

function getInitialHomeRoom(rooms: RoomSummary[]) {
  return rooms.find(
    (room) => !room.is_space && !room.is_direct && room.parent_space_ids.length === 0,
  );
}
