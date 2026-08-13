import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, MessageCircle, ShieldBan } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFlag } from "@/featureFlags";
import {
  getMutualRooms,
  getUserProfile,
  ignoreUser,
  onRoomDetailsUpdate,
  onRoomListUpdate,
  setRoomProfile,
  startDirectMessage,
} from "@/lib/matrix";
import { usePresence } from "@/features/presence/usePresence";
import { formatLastActiveAgo, presenceLabel } from "@/features/presence/PresenceDot";
import { Input } from "@/components/ui/input";
import { avatarColor, initials, resolveAvatar } from "./roomDisplay";

export interface MessagePillProfile {
  userId: string;
  label: string;
}

interface ProfileModerationActions {
  canSetPowerLevel: boolean;
  canKick: boolean;
  canBan: boolean;
  onSetPowerLevel: () => void;
  onKick: () => void;
  onBan: () => void;
}

function copyToClipboard(value: string) {
  void navigator.clipboard.writeText(value);
}

export function MessagePillProfileDialog({
  profile,
  accountId,
  currentUserId,
  roomId,
  detailed = false,
  roomMutationsBlocked = false,
  refetchOnMount = "always",
  onNavigateToRoom,
  moderationActions,
  onClose,
}: {
  profile: MessagePillProfile | null;
  accountId?: string;
  currentUserId?: string;
  roomId?: string;
  detailed?: boolean;
  roomMutationsBlocked?: boolean;
  refetchOnMount?: "always" | boolean;
  onNavigateToRoom?: (roomId: string) => void;
  moderationActions?: ProfileModerationActions;
  onClose: () => void;
}) {
  const userId = profile?.userId ?? "";
  const queryClient = useQueryClient();
  const presenceDetailsEnabled = useFlag("presence_privacy_controls");
  const avatarPresenceVisualsEnabled = useFlag("avatar_presence_visuals");
  const roomListSignatureRef = useRef<string | null>(null);
  const pendingProfileRefreshRef = useRef(false);
  const pendingMutualRoomsRefreshRef = useRef(false);
  useEffect(() => {
    pendingProfileRefreshRef.current = false;
    pendingMutualRoomsRefreshRef.current = false;
    roomListSignatureRef.current = null;
  }, [accountId, userId]);
  useEffect(() => {
    if (detailed) return;
    pendingProfileRefreshRef.current = false;
    pendingMutualRoomsRefreshRef.current = false;
    void queryClient.cancelQueries({ queryKey: ["user-profile", accountId ?? null, userId] });
    void queryClient.cancelQueries({ queryKey: ["mutual-rooms", accountId ?? null, userId] });
  }, [accountId, detailed, queryClient, userId]);
  const refreshMutualRooms = useCallback(() => {
    const queryKey = ["mutual-rooms", accountId ?? null, userId] as const;
    if (queryClient.isFetching({ queryKey, exact: true }) > 0) {
      pendingMutualRoomsRefreshRef.current = true;
    } else {
      void queryClient.invalidateQueries({ queryKey });
    }
  }, [accountId, queryClient, userId]);
  useEffect(() => {
    if (!detailed || !roomId || !userId) return undefined;
    const unlisten = onRoomDetailsUpdate((details) => {
      if (details.room_id === roomId) {
        const profileKey = [
          "user-profile",
          accountId ?? null,
          userId,
          roomId,
          avatarPresenceVisualsEnabled,
        ] as const;
        if (queryClient.isFetching({ queryKey: profileKey, exact: true }) > 0) {
          pendingProfileRefreshRef.current = true;
        } else {
          void queryClient.invalidateQueries({ queryKey: profileKey });
        }
      }
      refreshMutualRooms();
    });
    return () => {
      unlisten.then((stop) => stop()).catch(() => {});
    };
  }, [
    accountId,
    avatarPresenceVisualsEnabled,
    detailed,
    queryClient,
    refreshMutualRooms,
    roomId,
    userId,
  ]);
  useEffect(() => {
    if (!detailed || !userId) return undefined;
    const unlisten = onRoomListUpdate((rooms) => {
      const signature = rooms
        .map((room) =>
          [room.room_id, room.membership, room.name, room.avatar_url, room.avatar_path].join(
            "\u0000",
          ),
        )
        // Older supported WebViews do not expose ES2023 Array#toSorted.
        // oxlint-disable-next-line unicorn/no-array-sort
        .sort()
        .join("\u0001");
      if (roomListSignatureRef.current === signature) return;
      roomListSignatureRef.current = signature;
      refreshMutualRooms();
    });
    return () => {
      unlisten.then((stop) => stop()).catch(() => {});
    };
  }, [detailed, refreshMutualRooms, userId]);
  // getUserProfile already includes the initial presence snapshot. This hook
  // only needs to observe newer pushes while the card stays open.
  const livePresence = usePresence(detailed && userId !== "" ? userId : null, {
    fetchInitial: false,
  });
  const presenceRevisionRef = useRef(0);
  const lastLivePresenceRef = useRef(livePresence);
  const profileRequestPresenceRevisionRef = useRef(0);
  if (lastLivePresenceRef.current !== livePresence) {
    lastLivePresenceRef.current = livePresence;
    presenceRevisionRef.current += 1;
  }
  const profileQuery = useQuery({
    queryKey: [
      "user-profile",
      accountId ?? null,
      userId,
      roomId ?? null,
      avatarPresenceVisualsEnabled,
    ],
    queryFn: async () => {
      const requestPresenceRevision = presenceRevisionRef.current;
      const result = await getUserProfile(userId, roomId, avatarPresenceVisualsEnabled);
      profileRequestPresenceRevisionRef.current = requestPresenceRevision;
      return result;
    },
    enabled: detailed && userId !== "",
    refetchOnMount,
  });
  const profileIsFetching = profileQuery.isFetching;
  const refetchProfile = profileQuery.refetch;
  useEffect(() => {
    if (!profileIsFetching && pendingProfileRefreshRef.current) {
      pendingProfileRefreshRef.current = false;
      void refetchProfile();
    }
  }, [profileIsFetching, refetchProfile]);
  const mutualRoomsQuery = useQuery({
    queryKey: ["mutual-rooms", accountId ?? null, userId],
    queryFn: () => getMutualRooms(userId),
    enabled: detailed && userId !== "",
    refetchOnMount,
  });
  const mutualRoomsAreFetching = mutualRoomsQuery.isFetching;
  const refetchMutualRooms = mutualRoomsQuery.refetch;
  useEffect(() => {
    if (!mutualRoomsAreFetching && pendingMutualRoomsRefreshRef.current) {
      pendingMutualRoomsRefreshRef.current = false;
      void refetchMutualRooms();
    }
  }, [mutualRoomsAreFetching, refetchMutualRooms]);
  const resolvedProfile = detailed ? profileQuery.data : undefined;
  const presence =
    presenceRevisionRef.current === profileRequestPresenceRevisionRef.current
      ? (resolvedProfile?.presence ?? livePresence)
      : (livePresence ?? resolvedProfile?.presence);
  const displayName =
    resolvedProfile?.room_display_name ?? resolvedProfile?.display_name ?? profile?.label ?? null;
  const avatarUrl = resolvedProfile?.room_avatar_url ?? resolvedProfile?.avatar_url ?? null;
  const avatarPath = resolvedProfile?.room_avatar_path ?? resolvedProfile?.avatar_path ?? null;
  const roomIdentityDiffers =
    (resolvedProfile?.room_display_name != null &&
      resolvedProfile.room_display_name !== resolvedProfile.display_name) ||
    (resolvedProfile?.room_avatar_url != null &&
      resolvedProfile.room_avatar_url !== resolvedProfile.avatar_url) ||
    (resolvedProfile?.room_avatar_path != null &&
      resolvedProfile.room_avatar_path !== resolvedProfile.avatar_path);
  const isSelf = currentUserId != null && profile?.userId === currentUserId;
  const [editingRoomProfile, setEditingRoomProfile] = useState(false);
  const [roomDisplayName, setRoomDisplayName] = useState("");
  const [roomAvatarUrl, setRoomAvatarUrl] = useState("");
  useLayoutEffect(() => {
    setEditingRoomProfile(false);
    setRoomDisplayName("");
    setRoomAvatarUrl("");
  }, [roomId, userId]);
  useEffect(() => {
    if (roomMutationsBlocked) setEditingRoomProfile(false);
  }, [roomMutationsBlocked]);
  const startDm = useMutation({
    mutationFn: () => startDirectMessage(userId),
    onSuccess: (directRoomId) => {
      onNavigateToRoom?.(directRoomId);
      onClose();
    },
  });
  const blockUser = useMutation({
    mutationFn: () => ignoreUser(userId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", "ignored-users"] }),
  });
  const saveRoomProfile = useMutation({
    mutationFn: () => {
      if (roomMutationsBlocked) {
        throw new Error("This room is read-only");
      }
      return setRoomProfile(
        roomId ?? "",
        roomDisplayName.trim() || null,
        roomAvatarUrl.trim() || null,
      );
    },
    onSuccess: async () => {
      setEditingRoomProfile(false);
      await profileQuery.refetch();
    },
  });

  return (
    <Dialog open={profile !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        {profile && (
          <DialogHeader className="items-center text-center">
            <Avatar size="lg">
              <AvatarImage src={resolveAvatar(avatarPath, avatarUrl)} alt="" />
              <AvatarFallback
                style={{ background: avatarColor(profile.userId) }}
                className="font-bold text-white"
              >
                {initials(profile.userId, displayName)}
              </AvatarFallback>
            </Avatar>
            <DialogTitle className="max-w-full min-w-0 break-words">{displayName}</DialogTitle>
            <DialogDescription className="max-w-full min-w-0 break-all">
              {profile.userId}
            </DialogDescription>
            {detailed && (
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => copyToClipboard(profile.userId)}
                >
                  <Copy className="size-3.5" /> Copy ID
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => copyToClipboard(`https://matrix.to/#/${profile.userId}`)}
                >
                  <Copy className="size-3.5" /> Copy link
                </Button>
              </div>
            )}
            {detailed && resolvedProfile && roomIdentityDiffers && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Avatar size="sm">
                  <AvatarImage
                    src={resolveAvatar(resolvedProfile.avatar_path, resolvedProfile.avatar_url)}
                    alt=""
                  />
                  <AvatarFallback
                    style={{ background: avatarColor(profile.userId) }}
                    className="text-white"
                  >
                    {initials(profile.userId, resolvedProfile.display_name)}
                  </AvatarFallback>
                </Avatar>
                <span>Global profile: {resolvedProfile.display_name ?? profile.userId}</span>
              </div>
            )}
            {detailed && profileQuery.isPending && (
              <p className="text-sm text-muted-foreground">Loading profile…</p>
            )}
            {detailed && profileQuery.isError && (
              <p role="alert" className="text-sm text-destructive">
                Profile details could not be loaded.
              </p>
            )}
            {detailed && presence && (
              <div className="max-w-full min-w-0 text-sm text-muted-foreground">
                <p className="break-words">
                  {presenceLabel(
                    presence.presence === "dnd" && !avatarPresenceVisualsEnabled
                      ? "offline"
                      : presence.presence,
                  )}
                  {presenceDetailsEnabled && presence.status_msg ? ` · ${presence.status_msg}` : ""}
                </p>
                {presenceDetailsEnabled && presence.last_active_ago_ms != null && (
                  <p>{formatLastActiveAgo(presence.last_active_ago_ms)}</p>
                )}
              </div>
            )}
            {detailed && !isSelf && (
              <div className="flex flex-wrap justify-center gap-2 pt-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={!onNavigateToRoom || startDm.isPending}
                  onClick={() => startDm.mutate()}
                >
                  <MessageCircle className="size-4" /> Message
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={blockUser.isPending}
                  onClick={() => blockUser.mutate()}
                >
                  <ShieldBan className="size-4" /> Block
                </Button>
              </div>
            )}
            {(startDm.isError || blockUser.isError) && (
              <p role="alert" className="text-sm text-destructive">
                That profile action could not be completed.
              </p>
            )}
            {detailed && !isSelf && moderationActions && (
              <div className="flex w-full flex-wrap justify-center gap-2 border-t border-border pt-3">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!moderationActions.canSetPowerLevel}
                  onClick={moderationActions.onSetPowerLevel}
                >
                  Set power level
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!moderationActions.canKick}
                  onClick={moderationActions.onKick}
                >
                  Kick
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={!moderationActions.canBan}
                  onClick={moderationActions.onBan}
                >
                  Ban
                </Button>
              </div>
            )}
            {detailed && isSelf && roomId && resolvedProfile && !editingRoomProfile && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={roomMutationsBlocked}
                onClick={() => {
                  setRoomDisplayName(
                    resolvedProfile?.room_display_name ?? resolvedProfile?.display_name ?? "",
                  );
                  setRoomAvatarUrl(
                    resolvedProfile?.room_avatar_url ?? resolvedProfile?.avatar_url ?? "",
                  );
                  setEditingRoomProfile(true);
                }}
              >
                Edit room profile
              </Button>
            )}
            {detailed && isSelf && roomId && resolvedProfile && editingRoomProfile && (
              <form
                className="flex w-full flex-col gap-2 pt-2 text-left"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveRoomProfile.mutate();
                }}
              >
                <label className="text-xs font-medium" htmlFor="room-profile-display-name">
                  Display name in this room
                </label>
                <Input
                  id="room-profile-display-name"
                  value={roomDisplayName}
                  onChange={(event) => setRoomDisplayName(event.target.value)}
                />
                <label className="text-xs font-medium" htmlFor="room-profile-avatar-url">
                  Avatar MXC URL in this room
                </label>
                <Input
                  id="room-profile-avatar-url"
                  placeholder="mxc://server/media-id"
                  value={roomAvatarUrl}
                  onChange={(event) => setRoomAvatarUrl(event.target.value)}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditingRoomProfile(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={saveRoomProfile.isPending}>
                    Save room profile
                  </Button>
                </div>
                {saveRoomProfile.isError && (
                  <p role="alert" className="text-sm text-destructive">
                    Room profile could not be updated.
                  </p>
                )}
              </form>
            )}
            {detailed && mutualRoomsQuery.isError && (
              <p role="alert" className="text-sm text-destructive">
                Mutual rooms could not be loaded.
              </p>
            )}
            {detailed && mutualRoomsQuery.data && mutualRoomsQuery.data.length > 0 && (
              <div className="flex w-full flex-col gap-1 pt-2 text-left">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Mutual rooms
                </p>
                {mutualRoomsQuery.data.map((room) => (
                  <Button
                    key={room.room_id}
                    type="button"
                    variant="ghost"
                    className="h-auto min-h-11 w-full min-w-0 shrink justify-start overflow-hidden px-2 py-1.5 whitespace-normal"
                    disabled={!onNavigateToRoom}
                    onClick={() => {
                      onNavigateToRoom?.(room.room_id);
                      onClose();
                    }}
                  >
                    <span className="min-w-0 truncate">{room.name ?? room.room_id}</span>
                  </Button>
                ))}
              </div>
            )}
          </DialogHeader>
        )}
      </DialogContent>
    </Dialog>
  );
}
