import { useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { RoomList } from "./RoomList";
import { SpaceRail, type RoomListMode } from "./SpaceRail";
import { CreateJoinSpaceDialog } from "./CreateJoinSpaceDialog";
import { ChatShell } from "./ChatShell";
import { MessageSearchDialog } from "./MessageSearchDialog";
import { QuickSwitcherDialog } from "./QuickSwitcherDialog";
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
  joinRoom,
  listRooms,
  onRoomListUpdate,
  resolveRoomAlias,
  setFocusedRoom,
  type RoomSummary,
  type SearchResult,
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
import {
  useFeatureFlagPersistenceSettled,
  useFeatureFlagPersistenceVersion,
  useFlag,
} from "@/featureFlags";
import { isWebBuild } from "@/lib/platform";
import { useIdlePresence } from "@/features/settings/useIdlePresence";
import { usePrivacySettings } from "@/features/settings/usePrivacySettings";

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
  // Spec 31 is native-only until the web transport can perform the same
  // authoritative tombstone read as the Tauri command.
  const roomUpgradesEnabled = useFlag("room_upgrades") && !isWebBuild();
  const roomUpgradesPersistenceVersion = useFeatureFlagPersistenceVersion("room_upgrades");
  const roomUpgradesPersistenceSettled = useFeatureFlagPersistenceSettled("room_upgrades");
  const presencePrivacyControlsEnabled = useFlag("presence_privacy_controls");
  const messageSearchEnabled = useFlag("encrypted_local_message_search");
  const quickSwitcherEnabled = useFlag("quick_switcher");
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const roomsRef = useRef(rooms);
  roomsRef.current = rooms;
  const [roomsLoaded, setRoomsLoaded] = useState(false);
  const [syncedRoomListReceived, setSyncedRoomListReceived] = useState(false);
  const syncedRoomListReceivedRef = useRef(false);
  const roomListUpdateRevisionRef = useRef(0);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [roomListMode, setRoomListMode] = useState<RoomListMode>("home");
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const [showAllRooms, setShowAllRooms] = useState(false);
  const [createJoinDialogOpen, setCreateJoinDialogOpen] = useState(false);
  const [messageSearchOpen, setMessageSearchOpen] = useState(false);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const quickSwitcherReturnFocusRef = useRef<HTMLElement | null>(null);
  const [createSpaceParentId, setCreateSpaceParentId] = useState<string | null>(null);
  const setRoomSettingsTarget = useSetAtom(roomSettingsAtom);
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
  const [profileRoomPendingSelection, setProfileRoomPendingSelection] = useState<string | null>(
    null,
  );
  const profileRoomNavigationRequestRef = useRef(0);
  // "Jump to message" — the room + event to scroll to once that room is
  // selected and loaded. Shared by two entry points that both just need
  // "load this event into view, paginating around it if it's outside the
  // loaded window if necessary": Spec 12's Saved Messages settings panel,
  // and the day-2 Spec 04 pinned-messages panel. `ChatShell` clears this
  // itself (via `onJumpHandled`) once the jump completes or definitively
  // fails, rather than this screen guessing when that happened.
  //
  // Review fix: this used to track only the event id, not which room it was
  // for. If the user clicked a saved message in room A, then manually
  // switched to room B before the jump resolved, the bare event id would
  // still be handed to whichever room was active by the time `ChatShell`'s
  // effect ran — sending room A's event id into a `loadTimelineAroundEvent`
  // call scoped to room B, which could clear or fail the jump based on an
  // unrelated room. Storing the intended room id alongside the event id,
  // and only passing the event id down to `ChatShell` when the currently
  // active room actually matches it (see `activeJumpToEventId` below),
  // means a manual room switch mid-jump simply stops the jump from ever
  // reaching the wrong room, without needing to separately detect and clear
  // it on every possible room-change path.
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

  useEffect(() => {
    if (!quickSwitcherEnabled) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        quickSwitcherReturnFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setQuickSwitcherOpen(true);
      } else if (key === "f" && messageSearchEnabled) {
        event.preventDefault();
        setMessageSearchOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [messageSearchEnabled, quickSwitcherEnabled]);

  function openQuickSwitcher() {
    quickSwitcherReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuickSwitcherOpen(true);
  }

  function selectRoom(roomId: string) {
    profileRoomNavigationRequestRef.current += 1;
    setProfileRoomPendingSelection(null);
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

  async function navigateToProfileRoom(roomId: string) {
    const requestId = profileRoomNavigationRequestRef.current + 1;
    profileRoomNavigationRequestRef.current = requestId;
    // Arm the exact target before any refresh can publish a room snapshot.
    // This both lets a concurrent room-list update complete the navigation
    // and prevents initial auto-selection from stealing an explicit profile
    // action while no chat is active.
    setProfileRoomPendingSelection(roomId);
    let visibleRooms = roomsRef.current;
    let joinedRoom = visibleRooms.find(
      (candidate) => candidate.room_id === roomId && candidate.membership === "join",
    );
    if (!joinedRoom) {
      try {
        // `start_direct_message` can return a newly-created room before the
        // background `room_list:update` reaches React. Publish an immediate
        // SDK snapshot before selecting it so `activeRoom` and ChatShell move
        // together instead of briefly rendering an empty conversation pane.
        visibleRooms = await refreshRooms();
        joinedRoom = visibleRooms.find(
          (candidate) => candidate.room_id === roomId && candidate.membership === "join",
        );
      } catch (error) {
        logAndIgnore(error);
      }
    }
    if (profileRoomNavigationRequestRef.current !== requestId) return;
    if (joinedRoom) {
      selectRoomInVisibleMode(joinedRoom, visibleRooms);
      return;
    }
    // If the immediate SDK snapshot is also behind, retain the already-armed
    // intent until the normal room-list stream publishes this specific target.
  }

  async function followRoomUpgrade(roomId: string) {
    const alreadyJoined = roomsRef.current.some(
      (candidate) => candidate.room_id === roomId && candidate.membership === "join",
    );
    if (!alreadyJoined) {
      await joinRoom(roomId);
    }
    await navigateToProfileRoom(roomId);
  }

  function selectHome() {
    profileRoomNavigationRequestRef.current += 1;
    setProfileRoomPendingSelection(null);
    autoSelectSuppressedRef.current = null;
    setRoomListMode("home");
    setSelectedSpaceId(null);
  }

  function selectDms() {
    profileRoomNavigationRequestRef.current += 1;
    setProfileRoomPendingSelection(null);
    autoSelectSuppressedRef.current = null;
    setRoomListMode("dms");
    setSelectedSpaceId(null);
  }

  function selectSpace(spaceId: string) {
    profileRoomNavigationRequestRef.current += 1;
    setProfileRoomPendingSelection(null);
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

  function handleMessageSearchResult(result: SearchResult) {
    const room = joinedRooms.find((candidate) => candidate.room_id === result.room_id);
    if (!room) return false;
    selectRoomInVisibleMode(room);
    setJumpTarget({ roomId: result.room_id, eventId: result.event_id });
    return true;
  }

  function selectRoomInVisibleMode(room: RoomSummary, visibleRooms = joinedRooms) {
    if (room.is_space) {
      selectSpace(room.room_id);
      // This is an explicit request to stay in the space scope with no room
      // selected. Suppress the normal empty-detail auto-select just as the
      // deep-link and newly-created-space paths do.
      autoSelectSuppressedRef.current = { kind: "space" };
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

  // Spec 40 auto-idle/away: flag-gated (the settings surface itself is
  // gated by `presence_privacy_controls`, so `idle_timeout_minutes` can
  // never be non-null with the flag off) — `usePrivacySettings`'s `enabled`
  // arg keeps this from even fetching privacy settings when the flag is off
  // (review fix: it previously always fetched regardless of the flag, and
  // regardless of web build — `usePrivacySettings` now also refuses to fire
  // on the web companion build, which has no transport for this command).
  const { data: privacySettings } = usePrivacySettings(presencePrivacyControlsEnabled);
  useIdlePresence(presencePrivacyControlsEnabled ? privacySettings : undefined);

  const joinedRooms = useMemo(() => rooms.filter((room) => room.membership === "join"), [rooms]);
  const activeRoom = joinedRooms.find((room) => room.room_id === activeRoomId) ?? null;
  const focusedRoomId = activeRoom?.room_id ?? null;

  useEffect(() => {
    let cancelled = false;
    listRooms()
      .then((nextRooms) => {
        if (cancelled || syncedRoomListReceivedRef.current) return;
        roomsRef.current = nextRooms;
        setRooms(nextRooms);
      })
      .catch(logAndIgnore)
      .finally(() => {
        if (!cancelled) setRoomsLoaded(true);
      });
    const unlisten = onRoomListUpdate((nextRooms) => {
      if (cancelled) return;
      syncedRoomListReceivedRef.current = true;
      roomListUpdateRevisionRef.current += 1;
      setSyncedRoomListReceived(true);
      roomsRef.current = nextRooms;
      setRooms(nextRooms);
      setRoomsLoaded(true);
    });
    return () => {
      cancelled = true;
      unlisten.then((fn) => fn()).catch(logAndIgnore);
    };
  }, []);

  async function refreshRooms() {
    const roomListUpdateRevision = roomListUpdateRevisionRef.current;
    const nextRooms = await listRooms();
    // A room-list push published after this refresh started is newer than
    // its point-in-time SDK snapshot. Keep and return the push so a slow
    // refresh cannot roll the UI back or hide a newly-created DM.
    if (roomListUpdateRevisionRef.current !== roomListUpdateRevision) {
      return roomsRef.current;
    }
    roomsRef.current = nextRooms;
    setRooms(nextRooms);
    return nextRooms;
  }

  async function handleAcceptInvite(roomId: string) {
    // Accepting an invite is a newer explicit navigation intent than any DM
    // still waiting for its room-list entry. Cancel that older request before
    // the join or refresh can publish a snapshot containing both targets.
    profileRoomNavigationRequestRef.current += 1;
    setProfileRoomPendingSelection(null);
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

  useEffect(() => {
    if (!profileRoomPendingSelection) return;
    const joinedRoom = rooms.find(
      (room) => room.room_id === profileRoomPendingSelection && room.membership === "join",
    );
    if (!joinedRoom) return;
    selectRoomInVisibleMode(joinedRoom, joinedRooms);
    setProfileRoomPendingSelection(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileRoomPendingSelection, rooms, joinedRooms]);

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
    if (profileRoomPendingSelection) return; // let explicit profile-card navigation win
    const firstSelectableRoom = getInitialSelectableRoom(joinedRooms);
    if (activeRoomId === null && firstSelectableRoom) {
      if (autoSelectSuppressedRef.current) return;
      selectRoomInVisibleMode(firstSelectableRoom);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    joinedRooms,
    activeRoomId,
    deepLinkRoomId,
    acceptedRoomPendingSelection,
    profileRoomPendingSelection,
  ]);

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
  const {
    data: activeRoomDetails,
    isSuccess: activeRoomStateLoaded,
    isFetching: activeRoomStateFetching,
    isRefetchError: activeRoomStateRefetchFailed,
    refetch: refetchActiveRoomState,
  } = useRoomDetails(activeRoom?.room_id ?? null, true);
  const [authoritativeRoomState, setAuthoritativeRoomState] = useState<{
    roomId: string;
    persistenceVersion: number;
  } | null>(null);
  useEffect(() => {
    const roomId = activeRoom?.room_id;
    if (!roomUpgradesEnabled || !roomId || !roomUpgradesPersistenceSettled) {
      setAuthoritativeRoomState(null);
      return undefined;
    }

    let cancelled = false;
    setAuthoritativeRoomState(null);
    void refetchActiveRoomState()
      .then((result) => {
        if (!cancelled && !result.isError) {
          setAuthoritativeRoomState({
            roomId,
            persistenceVersion: roomUpgradesPersistenceVersion,
          });
        }
      })
      .catch(logAndIgnore);
    return () => {
      cancelled = true;
    };
  }, [
    activeRoom?.room_id,
    refetchActiveRoomState,
    roomUpgradesEnabled,
    roomUpgradesPersistenceSettled,
    roomUpgradesPersistenceVersion,
  ]);
  const authoritativeRoomStateResolved =
    !roomUpgradesEnabled ||
    (roomUpgradesPersistenceSettled &&
      authoritativeRoomState?.roomId === activeRoom?.room_id &&
      authoritativeRoomState?.persistenceVersion === roomUpgradesPersistenceVersion);
  const activeRoomStateResolved =
    activeRoomStateLoaded &&
    !activeRoomStateFetching &&
    !activeRoomStateRefetchFailed &&
    authoritativeRoomStateResolved;
  const [membersDrawerOpen, setMembersDrawerOpen] = useAtom(
    activeRoom ? membersDrawerOpenAtomFamily(activeRoom.room_id) : noRoomMembersDrawerOpenAtom,
  );
  const [pinnedMessagesDrawerOpen, setPinnedMessagesDrawerOpen] = useAtom(
    activeRoom
      ? pinnedMessagesDrawerOpenAtomFamily(activeRoom.room_id)
      : noRoomPinnedMessagesDrawerOpenAtom,
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
            onCreateJoin={() => {
              setCreateSpaceParentId(null);
              setCreateJoinDialogOpen(true);
            }}
            onCreateUnderSpace={(spaceId) => {
              setCreateSpaceParentId(spaceId);
              setCreateJoinDialogOpen(true);
            }}
            onOpenSettings={(spaceId) =>
              setRoomSettingsTarget({ roomId: spaceId, section: "general", kind: "space" })
            }
            onSpaceChildrenChanged={() => {
              // SpaceRail reconciles its canonical placement immediately
              // and retains that override until a sync snapshot confirms
              // it. A manual listRooms() read is only another in-memory SDK
              // snapshot and can race a newer room_list:update, so refresh
              // only the live hierarchy consumer here.
              setHierarchyRefreshToken((token) => token + 1);
            }}
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
            currentUserId={currentUserId}
            onSelectRoom={selectRoom}
            onDirectoryJoined={navigateToProfileRoom}
            onSelectSpace={selectSpace}
            onSelectSearchResult={selectRoomInVisibleMode}
            onOpenMessageSearch={
              messageSearchEnabled ? () => setMessageSearchOpen(true) : undefined
            }
            messageSearchShortcutEnabled={messageSearchEnabled && quickSwitcherEnabled}
            onOpenQuickSwitcher={quickSwitcherEnabled ? openQuickSwitcher : undefined}
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
            room={activeRoom}
            currentUserId={currentUserId}
            onBack={() => setMobileView("list")}
            onNavigateToRoom={navigateToRoomPill}
            onNavigateToProfileRoom={navigateToProfileRoom}
            currentTombstone={activeRoomDetails?.tombstone ?? null}
            currentRoomStateResolved={activeRoomStateResolved}
            onFollowRoomUpgrade={followRoomUpgrade}
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
              roomStateResolved={activeRoomStateResolved}
              onClose={() => setPinnedMessagesDrawerOpen(false)}
              // Review fix: this used to call `ChatShell`'s own imperative
              // `scrollToMessage` (a plain in-loaded-window `scrollToIndex`,
              // no pagination fallback) — a pin from before the currently
              // loaded window (the common case for an old pin) silently did
              // nothing. Routing through the same `jumpTarget`/
              // `jumpToEventId` mechanism Saved Messages' bookmark jumps
              // already use gets the `loadTimelineAroundEvent` fallback for
              // free, and (on mobile) `setPinnedMessagesDrawerOpen(false)`
              // below still remounts `ChatShell` into the `content` slot —
              // the jump reaching it is now driven by this prop rather than
              // a ref that had to be re-populated after that remount.
              onJumpToMessage={(eventId) => {
                setJumpTarget({ roomId: activeRoom.room_id, eventId });
                if (layout === "mobile") setPinnedMessagesDrawerOpen(false);
              }}
            />
          ) : activeRoom && membersDrawerOpen ? (
            <MembersDrawer
              roomId={activeRoom.room_id}
              currentUserId={currentUserId}
              mutationsBlocked={
                roomUpgradesEnabled &&
                (!activeRoomStateResolved || Boolean(activeRoomDetails?.tombstone))
              }
              onNavigateToRoom={navigateToProfileRoom}
              onClose={() => setMembersDrawerOpen(false)}
            />
          ) : null
        }
      />
      <CreateJoinSpaceDialog
        open={createJoinDialogOpen}
        parentSpaceId={createSpaceParentId}
        onOpenChange={(open) => {
          setCreateJoinDialogOpen(open);
          if (!open) setCreateSpaceParentId(null);
        }}
        onSpaceCreated={(spaceId) => {
          selectNewlyCreatedOrJoinedSpace(spaceId);
          setHierarchyRefreshToken((token) => token + 1);
        }}
        onSpaceJoined={(spaceId) => selectNewlyCreatedOrJoinedSpace(spaceId)}
      />
      {messageSearchEnabled && (
        <MessageSearchDialog
          open={messageSearchOpen}
          onOpenChange={setMessageSearchOpen}
          rooms={joinedRooms}
          activeRoomId={activeRoomId}
          onSelectResult={handleMessageSearchResult}
        />
      )}
      {quickSwitcherEnabled && (
        <QuickSwitcherDialog
          open={quickSwitcherOpen}
          onOpenChange={setQuickSwitcherOpen}
          rooms={joinedRooms}
          recentsPruningReady={syncedRoomListReceived}
          currentUserId={currentUserId}
          onSelectRoom={selectRoomInVisibleMode}
          returnFocusRef={quickSwitcherReturnFocusRef}
        />
      )}
      <RoomSettingsModal
        currentUserId={currentUserId}
        rooms={joinedRooms}
        onNavigateToRoom={navigateToProfileRoom}
        onRoomUpgraded={followRoomUpgrade}
        onSpaceChildrenChanged={() => {
          setHierarchyRefreshToken((token) => token + 1);
        }}
      />
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
