import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addNotificationKeyword,
  getNotificationSettings,
  removeNotificationKeyword,
  setDefaultNotificationMode,
  setGlobalMute,
  setRoomNotificationMode,
  setSoundEnabled,
  type RoomNotificationModeKind,
} from "@/lib/matrix";

const NOTIFICATION_SETTINGS_QUERY_KEY = ["notificationSettings"] as const;
/** Matches `NotificationsPanel`'s `listRooms` query key exactly. */
const NOTIFICATIONS_PANEL_ROOMS_QUERY_KEY = ["rooms", "notifications-panel"] as const;

export function useNotificationSettings() {
  return useQuery({
    queryKey: NOTIFICATION_SETTINGS_QUERY_KEY,
    queryFn: getNotificationSettings,
  });
}

export function useNotificationSettingsActions() {
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: NOTIFICATION_SETTINGS_QUERY_KEY });

  const setDefaultMode = useMutation({
    mutationFn: (mode: RoomNotificationModeKind) => setDefaultNotificationMode(mode),
    onSuccess: invalidate,
  });
  const addKeyword = useMutation({
    mutationFn: (keyword: string) => addNotificationKeyword(keyword),
    onSuccess: invalidate,
  });
  const removeKeyword = useMutation({
    mutationFn: (keyword: string) => removeNotificationKeyword(keyword),
    onSuccess: invalidate,
  });
  const setMute = useMutation({
    mutationFn: (muted: boolean) => setGlobalMute(muted),
    onSuccess: invalidate,
  });
  const setSound = useMutation({
    mutationFn: (enabled: boolean) => setSoundEnabled(enabled),
    onSuccess: invalidate,
  });
  // There's no per-room-mode getter command yet (see `NotificationsPanel`'s
  // `RoomModeRow`, which derives its displayed mode from `room.is_muted`),
  // but `listRooms` does carry that signal — invalidating it here means a
  // mute/unmute change is reflected on refetch instead of showing stale
  // state until an unrelated remount.
  const setRoomMode = useMutation({
    mutationFn: ({ roomId, mode }: { roomId: string; mode: RoomNotificationModeKind }) =>
      setRoomNotificationMode(roomId, mode),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_PANEL_ROOMS_QUERY_KEY }),
  });

  return { setDefaultMode, addKeyword, removeKeyword, setMute, setSound, setRoomMode };
}
