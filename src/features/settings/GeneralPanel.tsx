import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { getAutostart, setAutostart } from "@/lib/matrix";

const AUTOSTART_QUERY_KEY = ["settings", "autostart"];
const NOTIFICATION_PERMISSION_QUERY_KEY = ["settings", "notification-permission"];

/**
 * Start-on-login and OS notification-permission toggles (Spec 10) — the
 * commands/plugin these call live in `matrix/shell.rs` and
 * `tauri-plugin-notification`; this panel just surfaces them.
 */
export function GeneralPanel() {
  const queryClient = useQueryClient();
  const { data: autostartEnabled } = useQuery({
    queryKey: AUTOSTART_QUERY_KEY,
    queryFn: getAutostart,
  });
  const { data: notificationsGranted } = useQuery({
    queryKey: NOTIFICATION_PERMISSION_QUERY_KEY,
    queryFn: isPermissionGranted,
  });

  const setAutostartMutation = useMutation({
    mutationFn: setAutostart,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: AUTOSTART_QUERY_KEY }),
  });
  const requestNotificationPermission = useMutation({
    mutationFn: requestPermission,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NOTIFICATION_PERMISSION_QUERY_KEY }),
  });

  return (
    <div className="max-w-lg space-y-8">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-bold text-foreground">Start on login</h2>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={autostartEnabled ?? false}
              onChange={(e) => setAutostartMutation.mutate(e.target.checked)}
              disabled={setAutostartMutation.isPending}
            />
            Launch Charm when I log in
          </label>
        </div>
        <p className="text-sm text-muted-foreground">
          Starts Charm in the background so the tray icon and notifications are ready as soon as you
          sign in.
        </p>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-bold text-foreground">Desktop notifications</h2>
          {notificationsGranted ? (
            <span className="text-sm text-muted-foreground">Enabled</span>
          ) : (
            <button
              type="button"
              className="text-sm font-medium text-foreground underline"
              onClick={() => requestNotificationPermission.mutate()}
              disabled={requestNotificationPermission.isPending}
            >
              Enable
            </button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Charm shows a notification for a new message when its room isn't currently open. Per-room
          mute overrides live under Notifications.
        </p>
      </section>
    </div>
  );
}
