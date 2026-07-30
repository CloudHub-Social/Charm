import { useEffect } from "react";
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
import { getMutualRooms, getUserProfile, onRoomDetailsUpdate } from "@/lib/matrix";
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
  useEffect(() => {
    if (!detailed || !roomId || !userId) return undefined;
    const unlisten = onRoomDetailsUpdate((details) => {
      if (details.room_id !== roomId) return;
      void queryClient.invalidateQueries({
        queryKey: ["user-profile", accountId ?? null, userId, roomId],
      });
    });
    return () => {
      unlisten.then((stop) => stop()).catch(() => {});
    };
  }, [accountId, detailed, queryClient, roomId, userId]);
  const presenceDetailsEnabled = useFlag("presence_privacy_controls");
  const livePresence = usePresence(detailed && userId !== "" ? userId : null);
  const profileQuery = useQuery({
    queryKey: ["user-profile", accountId ?? null, userId, roomId ?? null],
    queryFn: () => getUserProfile(userId, roomId),
    enabled: detailed && userId !== "",
  });
  const mutualRoomsQuery = useQuery({
    queryKey: ["mutual-rooms", accountId ?? null, userId],
    queryFn: () => getMutualRooms(userId),
    enabled: detailed && userId !== "",
  });
  const resolvedProfile = detailed ? profileQuery.data : undefined;
  const presence = livePresence ?? resolvedProfile?.presence;
  const displayName =
    resolvedProfile?.room_display_name ?? resolvedProfile?.display_name ?? profile?.label ?? null;
  const avatarUrl = resolvedProfile?.room_avatar_url ?? resolvedProfile?.avatar_url ?? null;
  const avatarPath = resolvedProfile?.room_avatar_path ?? resolvedProfile?.avatar_path ?? null;

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
            {detailed &&
              resolvedProfile?.room_display_name &&
              resolvedProfile.display_name &&
              resolvedProfile.room_display_name !== resolvedProfile.display_name && (
                <p className="text-sm text-muted-foreground">
                  Global profile: {resolvedProfile.display_name}
                </p>
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
                    className="h-auto min-h-11 justify-start px-2 py-1.5"
                    disabled={!onNavigateToRoom}
                    onClick={() => {
                      onNavigateToRoom?.(room.room_id);
                      onClose();
                    }}
                  >
                    {room.name ?? room.room_id}
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
