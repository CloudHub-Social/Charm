import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { getIgnoredUsers, unignoreUser } from "@/lib/matrix";
import { SettingsCard, SettingTile } from "./components/SettingsCard";

const IGNORED_USERS_QUERY_KEY = ["settings", "ignored-users"];

/** Blocked/ignored users list (Spec 18) — blocking a user happens from their profile elsewhere in the app; this only lists and unblocks. */
export function BlockedUsersCard() {
  const queryClient = useQueryClient();
  const { data: ignoredUsers } = useQuery({
    queryKey: IGNORED_USERS_QUERY_KEY,
    queryFn: getIgnoredUsers,
  });

  const unblock = useMutation({
    mutationFn: unignoreUser,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: IGNORED_USERS_QUERY_KEY }),
  });

  if (ignoredUsers && ignoredUsers.length === 0) return null;

  return (
    <SettingsCard heading="Blocked Users">
      {ignoredUsers ? (
        ignoredUsers.map((userId) => (
          <SettingTile
            key={userId}
            title={userId}
            control={
              <Button
                variant="outline"
                size="sm"
                onClick={() => unblock.mutate(userId)}
                disabled={unblock.isPending && unblock.variables === userId}
              >
                Unblock
              </Button>
            }
          />
        ))
      ) : (
        <SettingTile title="Loading…" />
      )}
    </SettingsCard>
  );
}
