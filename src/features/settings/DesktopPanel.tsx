import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getAutostart, setAutostart } from "@/lib/matrix";
import { SettingsCard, SettingTile } from "./components/SettingsCard";

const AUTOSTART_QUERY_KEY = ["settings", "autostart"];

/**
 * Native-desktop-only toggles — split out of `GeneralPanel` (Spec 18) so
 * "General" doesn't carry desktop-specific concepts that make no sense on a
 * mobile build. Only shown on Tauri builds (see `SettingsScreen`'s
 * `desktopOnly` section filter); the commands this calls live in
 * `matrix/shell.rs`.
 */
export function DesktopPanel() {
  const queryClient = useQueryClient();
  const { data: autostartEnabled } = useQuery({
    queryKey: AUTOSTART_QUERY_KEY,
    queryFn: getAutostart,
  });

  const setAutostartMutation = useMutation({
    mutationFn: setAutostart,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: AUTOSTART_QUERY_KEY }),
  });

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-lg font-bold text-foreground">Desktop</h1>
      <SettingsCard heading="Startup">
        <SettingTile
          title="Launch Charm when I log in"
          description="Starts Charm in the background so the tray icon and notifications are ready as soon as you sign in."
          control={
            <input
              type="checkbox"
              aria-label="Launch Charm when I log in"
              checked={autostartEnabled ?? false}
              onChange={(e) => setAutostartMutation.mutate(e.target.checked)}
              disabled={setAutostartMutation.isPending}
            />
          }
        />
      </SettingsCard>
    </div>
  );
}
