import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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

  // Tracks every in-flight unblock by user id, not just the most recent —
  // a single `useMutation`'s `isPending`/`variables` only reflects its
  // latest call, so unblocking user A and then quickly user B would
  // re-enable A's button (and let its request re-fire) while A's mutation
  // was still in flight.
  const [pendingUserIds, setPendingUserIds] = useState<Set<string>>(new Set());

  const unblock = useMutation({
    mutationFn: unignoreUser,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: IGNORED_USERS_QUERY_KEY }),
    onSettled: (_data, _error, userId) => {
      setPendingUserIds((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    },
  });

  function handleUnblock(userId: string) {
    setPendingUserIds((prev) => new Set(prev).add(userId));
    unblock.mutate(userId);
  }

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
                onClick={() => handleUnblock(userId)}
                disabled={pendingUserIds.has(userId)}
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
