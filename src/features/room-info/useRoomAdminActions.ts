import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import {
  banMember,
  enableRoomEncryption,
  inviteMember,
  kickMember,
  removeRoomAvatar,
  setMemberPowerLevel,
  setRoomAvatar,
  setRoomHistoryVisibility,
  setRoomJoinRule,
  setRoomName,
  setRoomPowerLevelThresholds,
  setRoomTopic,
  unbanMember,
  type HistoryVisibilityKind,
  type JoinRuleKind,
  type PowerLevelThresholds,
} from "@/lib/matrix";
import { roomDetailsQueryKey } from "./useRoomDetails";
import { roomMembersQueryKey } from "./useRoomMembers";

/**
 * Wraps a room-admin IPC call in `useMutation`, invalidating both the Info
 * and Members queries on success as a fallback in case this room's
 * `room_details:update` (see `useRoomDetails`/`useRoomMembers`) is slow or
 * missed — per Spec 07's "no optimistic UI" design, the actual displayed
 * state always comes from a re-read, this is just a belt-and-suspenders nudge
 * to refetch promptly rather than waiting on the next sync tick.
 */
function useRoomAdminMutation<TVariables>(
  roomId: string,
  mutationFn: (variables: TVariables) => Promise<void>,
): UseMutationResult<void, Error, TVariables> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: roomDetailsQueryKey(roomId) });
      queryClient.invalidateQueries({ queryKey: roomMembersQueryKey(roomId) });
    },
  });
}

export function useRoomAdminActions(roomId: string) {
  return {
    setName: useRoomAdminMutation(roomId, (name: string) => setRoomName(roomId, name)),
    setTopic: useRoomAdminMutation(roomId, (topic: string) => setRoomTopic(roomId, topic)),
    setAvatar: useRoomAdminMutation(roomId, (filePath: string | File) =>
      setRoomAvatar(roomId, filePath),
    ),
    removeAvatar: useRoomAdminMutation(roomId, () => removeRoomAvatar(roomId)),
    setJoinRule: useRoomAdminMutation(roomId, (joinRule: JoinRuleKind) =>
      setRoomJoinRule(roomId, joinRule),
    ),
    setHistoryVisibility: useRoomAdminMutation(roomId, (visibility: HistoryVisibilityKind) =>
      setRoomHistoryVisibility(roomId, visibility),
    ),
    enableEncryption: useRoomAdminMutation(roomId, () => enableRoomEncryption(roomId)),
    setMemberPowerLevel: useRoomAdminMutation(
      roomId,
      (vars: { userId: string; powerLevel: number }) =>
        setMemberPowerLevel(roomId, vars.userId, vars.powerLevel),
    ),
    setPowerLevelThresholds: useRoomAdminMutation(roomId, (changes: PowerLevelThresholds) =>
      setRoomPowerLevelThresholds(roomId, changes),
    ),
    invite: useRoomAdminMutation(roomId, (userId: string) => inviteMember(roomId, userId)),
    kick: useRoomAdminMutation(roomId, (vars: { userId: string; reason?: string }) =>
      kickMember(roomId, vars.userId, vars.reason),
    ),
    ban: useRoomAdminMutation(roomId, (vars: { userId: string; reason?: string }) =>
      banMember(roomId, vars.userId, vars.reason),
    ),
    unban: useRoomAdminMutation(roomId, (vars: { userId: string; reason?: string }) =>
      unbanMember(roomId, vars.userId, vars.reason),
    ),
  };
}
