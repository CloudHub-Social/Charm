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
  // Not query-invalidated: there's no per-room-mode getter command yet (see
  // `NotificationsPanel`'s `RoomModeRow`), so there's nothing here to refetch.
  const setRoomMode = useMutation({
    mutationFn: ({ roomId, mode }: { roomId: string; mode: RoomNotificationModeKind }) =>
      setRoomNotificationMode(roomId, mode),
  });

  return { setDefaultMode, addKeyword, removeKeyword, setMute, setSound, setRoomMode };
}
