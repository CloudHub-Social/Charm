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
  // Rooms with no room-level override take on whichever mode is current here
  // (see `RoomSummary.notification_mode`), so a default-mode or global-mute
  // change shifts their *effective* mode too — without also invalidating the
  // rooms query, their rows in the Per-room overrides list would keep
  // showing the mode from before this change until an unrelated remount.
  const invalidateDefaultAndRooms = () => {
    invalidate();
    queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_PANEL_ROOMS_QUERY_KEY });
  };

  const setDefaultMode = useMutation({
    mutationFn: (mode: RoomNotificationModeKind) => setDefaultNotificationMode(mode),
    onSuccess: invalidateDefaultAndRooms,
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
    onSuccess: invalidateDefaultAndRooms,
  });
  const setSound = useMutation({
    mutationFn: (enabled: boolean) => setSoundEnabled(enabled),
    onSuccess: invalidate,
  });
  // `RoomSummary.notification_mode` (read by `NotificationsPanel`'s
  // `RoomModeRow`) is a snapshot from the last `listRooms` fetch — without
  // invalidating it here, a room-level override change wouldn't be reflected
  // until an unrelated remount.
  const setRoomMode = useMutation({
    mutationFn: ({ roomId, mode }: { roomId: string; mode: RoomNotificationModeKind }) =>
      setRoomNotificationMode(roomId, mode),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_PANEL_ROOMS_QUERY_KEY }),
  });

  return { setDefaultMode, addKeyword, removeKeyword, setMute, setSound, setRoomMode };
}
