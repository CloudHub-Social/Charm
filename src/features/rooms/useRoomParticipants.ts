import { useEffect, useState } from "react";
import { getRoomMembers, onRoomDetailsUpdate, type RoomMemberSummary } from "@/lib/matrix";
import { logAndIgnore } from "@/lib/logAndIgnore";

interface ParticipantsState {
  roomId: string | null;
  participants: RoomMemberSummary[];
}

const EMPTY_STATE: ParticipantsState = { roomId: null, participants: [] };

/**
 * Joined members of a room, other than the viewer, for the "following the
 * conversation" bar. Sourced from the same active-only `get_room_members`
 * the mention autocomplete uses (see its doc comment — joined + invited, not
 * the Members-tab's full `get_room_member_list`), filtered to
 * `membership === "join"` (an invited-but-not-yet-joined user hasn't seen
 * the conversation and shouldn't be counted as following it) and to exclude
 * `ownUserId` (a viewer never "follows" their own presence in a room — in a
 * solo/near-empty room this also avoids the bar rendering only the viewer's
 * own name).
 *
 * Refetches on `room_details:update` (the same signal `useRoomDetails`
 * invalidates the Members-tab query on) so a join/leave/kick while the room
 * stays open updates the bar without waiting for a room switch or reload.
 */
export function useRoomParticipants(roomId: string | null, ownUserId: string): RoomMemberSummary[] {
  const [state, setState] = useState<ParticipantsState>(EMPTY_STATE);

  // Resets synchronously during render (not in an effect) when the room
  // changes, so the first render of a newly-opened room never briefly shows
  // the previous room's participants before the effect below has a chance
  // to fetch — see https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes.
  if (state.roomId !== roomId) {
    setState({ roomId, participants: [] });
  }

  useEffect(() => {
    if (!roomId) return undefined;
    let cancelled = false;

    function load() {
      getRoomMembers(roomId as string)
        .then((members) => {
          if (cancelled) return;
          setState({
            roomId,
            participants: members.filter(
              (member) => member.membership === "join" && member.user_id !== ownUserId,
            ),
          });
        })
        .catch(logAndIgnore);
    }

    load();
    const unlisten = onRoomDetailsUpdate((details) => {
      if (details.room_id === roomId) load();
    });

    return () => {
      cancelled = true;
      unlisten.then((fn) => fn()).catch(logAndIgnore);
    };
  }, [roomId, ownUserId]);

  return state.roomId === roomId ? state.participants : [];
}

/** "Alice and Bob are following the conversation" / "Alice, Bob, and Carol are…" (oxford-comma'd, collapsing past 3 into "and N others"). */
export function followingLabel(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is following the conversation`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are following the conversation`;
  if (names.length === 3) {
    return `${names[0]}, ${names[1]}, and ${names[2]} are following the conversation`;
  }
  const shown = names.slice(0, 3);
  const rest = names.length - 3;
  return `${shown.join(", ")}, and ${rest} other${rest === 1 ? "" : "s"} are following the conversation`;
}
