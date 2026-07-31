import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  onRoomDetailsUpdate,
  onRoomListUpdate,
} from "@/lib/matrix";
import { usePresence } from "@/features/presence/usePresence";
import { avatarColor, initials, resolveAvatar } from "./roomDisplay";

export interface MessagePillProfile {
  userId: string;
  label: string;
}

export function MessagePillProfileDialog({
  profile,
  accountId,
  roomId,
  detailed = false,
  onNavigateToRoom,
  onClose,
}: {
  profile: MessagePillProfile | null;
  accountId?: string;
  roomId?: string;
  detailed?: boolean;
  onNavigateToRoom?: (roomId: string) => void;
  onClose: () => void;
}) {
  const userId = profile?.userId ?? "";
  const queryClient = useQueryClient();
  const roomListSignatureRef = useRef<string | null>(null);
  const pendingProfileRefreshRef = useRef(false);
  const pendingMutualRoomsRefreshRef = useRef(false);
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
        const profileKey = ["user-profile", accountId ?? null, userId, roomId] as const;
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
  }, [accountId, detailed, queryClient, refreshMutualRooms, roomId, userId]);
  useEffect(() => {
    if (!detailed || !userId) return undefined;
    const unlisten = onRoomListUpdate((rooms) => {
      const signature = rooms
        .map((room) =>
          [room.room_id, room.membership, room.name, room.avatar_url, room.avatar_path].join(
            "\u0000",
          ),
        )
        .toSorted()
        .join("\u0001");
      if (roomListSignatureRef.current === signature) return;
      roomListSignatureRef.current = signature;
      refreshMutualRooms();
    });
    return () => {
      unlisten.then((stop) => stop()).catch(() => {});
    };
  }, [detailed, refreshMutualRooms, userId]);
  const presenceDetailsEnabled = useFlag("presence_privacy_controls");
  const livePresence = usePresence(detailed && userId !== "" ? userId : null);
  const profileQuery = useQuery({
    queryKey: ["user-profile", accountId ?? null, userId, roomId ?? null],
    queryFn: () => getUserProfile(userId, roomId),
    enabled: detailed && userId !== "",
    refetchOnMount: "always",
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
    refetchOnMount: "always",
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
  const presence = livePresence ?? resolvedProfile?.presence;
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
            <DialogTitle>{displayName}</DialogTitle>
            <DialogDescription>{profile.userId}</DialogDescription>
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
              <p className="text-sm text-muted-foreground">
                {presence.presence === "unavailable" ? "away" : presence.presence}
                {presenceDetailsEnabled && presence.status_msg ? ` · ${presence.status_msg}` : ""}
              </p>
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
