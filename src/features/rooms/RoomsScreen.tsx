import { useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { RoomList } from "./RoomList";
import { SpaceRail, type RoomListMode } from "./SpaceRail";
import { CreateJoinSpaceDialog } from "./CreateJoinSpaceDialog";
import { ChatShell, type ChatShellHandle } from "./ChatShell";
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
import { PinnedMessagesPanel } from "@/features/room-info/PinnedMessagesPanel";
import { RoomSettingsModal } from "@/features/room-info/RoomSettingsModal";
import {
  membersDrawerOpenAtomFamily,
  noRoomMembersDrawerOpenAtom,
  noRoomPinnedMessagesDrawerOpenAtom,
  pinnedMessagesDrawerOpenAtomFamily,
  roomSettingsAtom,
} from "@/features/room-info/roomInfoAtoms";
import { useRoomDetails } from "@/features/room-info/useRoomDetails";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { useFlag } from "@/featureFlags";
import { isWebBuild } from "@/lib/platform";

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
  // Day-2 Spec 04 (message pinning). `ChatShell` already hides the header
  // button/menu entry that would set `pinnedMessagesDrawerOpen` while this is
  // off, but gating the panel's render here too means a previously-set atom
  // value (e.g. the flag flipped off mid-session) can't leave the panel
  // showing regardless.
  //
  // Review fix: matches `ChatShell`'s identical `messagePinningEnabled`
  // definition, which also excludes web builds (pin/unpin has no
  // `invokeWeb` case). This constant alone never called the Tauri IPC
  // command itself, so the omission wasn't yet a live bug, but keeping the
  // two definitions in sync avoids it becoming one the next time either
  // file's gating logic changes.
  const messagePinningEnabled = useFlag("message_pinning") && !isWebBuild();
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const roomsRef = useRef(rooms);
  roomsRef.current = rooms;
  const [roomsLoaded, setRoomsLoaded] = useState(false);
  const [syncedRoomListReceived, setSyncedRoomListReceived] = useState(false);
  const syncedRoomListReceivedRef = useRef(false);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [roomListMode, setRoomListMode] = useState<RoomListMode>("home");
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const [showAllRooms, setShowAllRooms] = useState(false);
  const [createJoinDialogOpen, setCreateJoinDialogOpen] = useState(false);
  // Bumped after `SpaceRail`'s "Add Existing" or "Remove from space" flows
  // edit a space's children — `RoomList`'s own hierarchy view is a
  // point-in-time `/hierarchy` snapshot Matrix sync doesn't keep current, so
  // this is the signal that tells it to refetch immediately rather than only
  // on the next mode/space switch.
  const [hierarchyRefreshToken, setHierarchyRefreshToken] = useState(0);
  const [resolvedDeepLinkTarget, setResolvedDeepLinkTarget] = useState<string | null>(null);
  const [acceptedRoomPendingSelection, setAcceptedRoomPendingSelection] = useState<string | null>(
    null,
  );
  // Spec 12's "jump to message" from the Saved Messages settings panel: the
  // room + event to scroll to once that room is selected and loaded.
  // `ChatShell` clears this itself (via `onJumpHandled`) once the jump
  // completes or definitively fails, rather than this screen guessing when
  // that happened.
  //
  // Review fix: this used to track only the event id, not which room it was
  // for. If the user clicked a saved message in room A, then manually
  // switched to room B before the jump resolved, the bare event id would
  // still be handed to whichever room was active by the time `ChatShell`'s
  // effect ran — sending room A's bookmark event id into a
  // `loadTimelineAroundEvent` call scoped to room B, which could clear or
  // fail the jump based on an unrelated room. Storing the intended room id
  // alongside the event id, and only passing the event id down to
  // `ChatShell` when the currently active room actually matches it (see
  // `activeJumpToEventId` below), means a manual room switch mid-jump simply
  // stops the jump from ever reaching the wrong room, without needing to
  // separately detect and clear it on every possible room-change path.
  const [jumpTarget, setJumpTarget] = useState<{ roomId: string; eventId: string } | null>(null);
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

  function navigateToRoomPill(roomIdentifier: string) {
    if (roomIdentifier.startsWith("!")) {
      const joinedRoom = roomsRef.current.find(
        (candidate) => candidate.room_id === roomIdentifier && candidate.membership === "join",
      );
      if (joinedRoom) selectRoomInVisibleMode(joinedRoom);
      return;
    }
    if (!roomIdentifier.startsWith("#")) return;
    resolveRoomAlias(roomIdentifier)
      .then((roomId) => {
        const joinedRoom = roomsRef.current.find(
          (candidate) => candidate.room_id === roomId && candidate.membership === "join",
        );
        if (joinedRoom) selectRoomInVisibleMode(joinedRoom);
      })
      .catch(logAndIgnore);
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

  /** Handles a jump-to-message click from the Saved Messages settings panel
   * (Spec 12): selects the bookmark's room (in whatever nav mode it belongs
   * to, same as clicking it in the room list) and hands the target event id
   * to `ChatShell`, which does the actual scroll/load-around once that room
   * is active. A bookmark whose room isn't currently joined (left since
   * saving) has nothing to select into — silently does nothing, same as
   * `navigateToRoomPill`'s handling of an unresolvable target. */
  function handleJumpToBookmark(roomId: string, eventId: string) {
    const room = joinedRooms.find((candidate) => candidate.room_id === roomId);
    if (!room) return;
    selectRoomInVisibleMode(room);
    setJumpTarget({ roomId, eventId });
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
  const activeRoom = joinedRooms.find((room) => room.room_id === activeRoomId) ?? null;
  const focusedRoomId = activeRoom?.room_id ?? null;

  useEffect(() => {
    let cancelled = false;
    listRooms()
      .then((nextRooms) => {
        if (cancelled || syncedRoomListReceivedRef.current) return;
        setRooms(nextRooms);
      })
      .catch(logAndIgnore)
      .finally(() => {
        if (!cancelled) setRoomsLoaded(true);
      });
    const unlisten = onRoomListUpdate((nextRooms) => {
      if (cancelled) return;
      syncedRoomListReceivedRef.current = true;
      setSyncedRoomListReceived(true);
      setRooms(nextRooms);
      setRoomsLoaded(true);
    });
    return () => {
      cancelled = true;
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
      setFocusedRoom(isShowingChat ? focusedRoomId : null).catch(logAndIgnore);
    }
    syncFocusedRoom();
    window.addEventListener("focus", syncFocusedRoom);
    window.addEventListener("blur", syncFocusedRoom);
    return () => {
      window.removeEventListener("focus", syncFocusedRoom);
      window.removeEventListener("blur", syncFocusedRoom);
    };
  }, [focusedRoomId, settingsSection, roomSettingsTarget, layout, mobileView]);

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
    } else if (!syncedRoomListReceived) {
      // `listRooms()` can return the SDK's restored local snapshot before the
      // first network sync has populated a room referenced by a launch-time
      // deep link. Keep the target pending until a sync-driven room list has
      // had a chance to include it.
      return;
    }
    // A resolved target absent from a sync-driven snapshot is stale or not
    // visible to this account. Consume it rather than letting it suppress
    // initial room selection forever.
    setResolvedDeepLinkTarget(null);
    onDeepLinkConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    resolvedDeepLinkTarget,
    rooms,
    roomsLoaded,
    syncedRoomListReceived,
    onDeepLinkConsumed,
    roomInvitesEnabled,
  ]);

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
  const [pinnedMessagesDrawerOpen, setPinnedMessagesDrawerOpen] = useAtom(
    activeRoom
      ? pinnedMessagesDrawerOpenAtomFamily(activeRoom.room_id)
      : noRoomPinnedMessagesDrawerOpenAtom,
  );
  // Lets `PinnedMessagesPanel` (rendered in the separate `rightPanel` slot
  // below, a sibling of `ChatShell` — see `ChatShellHandle`'s doc comment)
  // trigger the same in-timeline scroll-to-message `ChatShell` itself uses
  // for reply-preview/search-result jumps.
  const chatShellRef = useRef<ChatShellHandle>(null);
  // Review fix: on mobile, `AppShell` renders `rightPanel ?? content` — while
  // the pinned-messages panel is the visible `rightPanel`, `ChatShell`
  // itself isn't mounted at all, so `chatShellRef.current` is `null` and a
  // tap on a pinned row was a silent no-op. Closing the panel first
  // (`setPinnedMessagesDrawerOpen(false)`) remounts `ChatShell` as `content`
  // in the same commit; `chatShellRef.current` is populated again by the
  // time this effect runs (refs are set during commit, before effects), so
  // stashing the target here and scrolling once the panel has actually
  // closed reaches a real, mounted `ChatShell` instead of a stale ref.
  //
  // Review fix: carries the target `roomId` alongside the event id, not
  // just the event id alone — if the user quickly switches to a different
  // room after tapping a pinned message but before the panel-close effect
  // below runs, `ChatShell` remounts for the *new* room, and
  // `scrollToMessage` would silently fail to find the old room's event id
  // in this room's message list. Stored and checked against `activeRoom` so
  // a stale target for an already-abandoned room is dropped instead of
  // firing into the wrong room.
  const pendingMobileJumpRef = useRef<{ roomId: string; eventId: string } | null>(null);

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
    if (prevLayoutRef.current === "desktop" && layout === "mobile") {
      if (membersDrawerOpen) setMembersDrawerOpen(false);
      if (pinnedMessagesDrawerOpen) setPinnedMessagesDrawerOpen(false);
    }
    prevLayoutRef.current = layout;
  }, [
    layout,
    membersDrawerOpen,
    setMembersDrawerOpen,
    pinnedMessagesDrawerOpen,
    setPinnedMessagesDrawerOpen,
  ]);

  // See `pendingMobileJumpRef`'s own doc comment — runs once the
  // pinned-messages panel has actually closed (remounting `ChatShell`) and
  // there's a jump this same close was for.
  useEffect(() => {
    if (pinnedMessagesDrawerOpen) return;
    const pending = pendingMobileJumpRef.current;
    if (pending === null) return;
    pendingMobileJumpRef.current = null;
    if (pending.roomId !== activeRoom?.room_id) return;
    chatShellRef.current?.scrollToMessage(pending.eventId);
  }, [pinnedMessagesDrawerOpen, activeRoom?.room_id]);

  // Review fix: a pending mobile jump is only ever valid for the room it
  // was requested from — if the user switches rooms before the effect
  // above gets to run (e.g. via `RoomList` while the pinned panel is still
  // closing), drop it here rather than let a stale event id fire against
  // whatever room the user has since navigated to.
  useEffect(() => {
    pendingMobileJumpRef.current = null;
  }, [activeRoom?.room_id]);

  return (
    <>
      <AppShell
        spaceRail={
          <SpaceRail
            rooms={joinedRooms}
            activeMode={roomListMode}
            activeSpaceId={selectedSpaceId}
            showAllRooms={showAllRooms}
            currentUserId={currentUserId}
            onSelectHome={selectHome}
            onSelectDms={selectDms}
            onSelectSpace={selectSpace}
            onCreateJoin={() => setCreateJoinDialogOpen(true)}
            onSpaceChildrenChanged={() => setHierarchyRefreshToken((token) => token + 1)}
          />
        }
        activeRoomId={activeRoom?.room_id ?? null}
        selectionRequestId={selectionRequestId}
        mobileView={mobileView}
        onMobileViewChange={setMobileView}
        isSettingsActive={settingsSection !== null}
        roomList={
          <RoomList
            rooms={roomInvitesEnabled ? rooms : joinedRooms}
            loading={!roomsLoaded}
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
            hierarchyRefreshToken={hierarchyRefreshToken}
          />
        }
        content={
          <ChatShell
            ref={chatShellRef}
            room={activeRoom}
            currentUserId={currentUserId}
            onBack={() => setMobileView("list")}
            onNavigateToRoom={navigateToRoomPill}
            jumpToEventId={
              jumpTarget && activeRoom?.room_id === jumpTarget.roomId ? jumpTarget.eventId : null
            }
            onJumpHandled={() => setJumpTarget(null)}
          />
        }
        rightPanel={
          activeRoom && messagePinningEnabled && pinnedMessagesDrawerOpen ? (
            <PinnedMessagesPanel
              roomId={activeRoom.room_id}
              onClose={() => setPinnedMessagesDrawerOpen(false)}
              onJumpToMessage={(eventId) => {
                if (layout === "mobile") {
                  pendingMobileJumpRef.current = { roomId: activeRoom.room_id, eventId };
                  setPinnedMessagesDrawerOpen(false);
                  return;
                }
                chatShellRef.current?.scrollToMessage(eventId);
              }}
            />
          ) : activeRoom && membersDrawerOpen ? (
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
      <SettingsScreen onLoggedOut={onLoggedOut} onJumpToBookmark={handleJumpToBookmark} />
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
