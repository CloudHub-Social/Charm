import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { Button } from "@/components/ui/button";
import { SettingsCard, SettingTile } from "./components/SettingsCard";

const NOTIFICATION_PERMISSION_QUERY_KEY = ["settings", "notification-permission"];

/**
 * OS notification-permission toggle (Spec 10) — the autostart toggle moved
 * to `DesktopPanel` (Spec 18), since it's a native-desktop-only concept, not
 * a general one.
 */
export function GeneralPanel() {
  const queryClient = useQueryClient();
  const { data: notificationsGranted } = useQuery({
    queryKey: NOTIFICATION_PERMISSION_QUERY_KEY,
    queryFn: isPermissionGranted,
  });

  const requestNotificationPermission = useMutation({
    mutationFn: () => requestPermission(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NOTIFICATION_PERMISSION_QUERY_KEY }),
  });

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-lg font-bold text-foreground">General</h1>
      <SettingsCard heading="Notifications">
        <SettingTile
          title="Desktop notifications"
          description="Charm shows a notification for a new message when its room isn't currently open. Per-room mute overrides live under Notifications."
          control={
            notificationsGranted ? (
              <span className="text-sm text-muted-foreground">Enabled</span>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => requestNotificationPermission.mutate()}
                disabled={requestNotificationPermission.isPending}
              >
                Enable
              </Button>
            )
          }
        />
      </SettingsCard>
    </div>
  );
}
