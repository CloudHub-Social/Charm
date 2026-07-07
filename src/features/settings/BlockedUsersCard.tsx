import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { getIgnoredUsers, unignoreUser } from "@/lib/matrix";
import { SettingsCard, SettingTile } from "./components/SettingsCard";

const IGNORED_USERS_QUERY_KEY = ["settings", "ignored-users"];

/** Blocked/ignored users list (Spec 18) — blocking a user happens from their profile elsewhere in the app; this only lists and unblocks. */
export function BlockedUsersCard() {
  const queryClient = useQueryClient();
  const {
    data: ignoredUsers,
    isError,
    error,
  } = useQuery({
    queryKey: IGNORED_USERS_QUERY_KEY,
    queryFn: getIgnoredUsers,
  });

  // Tracks every in-flight unblock by user id (not just the most recent —
  // a single `useMutation`'s `isPending`/`variables` only reflects its
  // latest call) and, more importantly, serializes them: `unignore_user`
  // does a read-modify-write of the whole `m.ignored_user_list` account
  // data event on the server, so two concurrent unblocks for *different*
  // users can both read the same list and each write back a version
  // missing only their own removal — whichever write lands last silently
  // re-blocks the other user. Only one request may be in flight at a time.
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
    if (pendingUserIds.size > 0) return;
    setPendingUserIds((prev) => new Set(prev).add(userId));
    unblock.mutate(userId);
  }

  if (!isError && ignoredUsers && ignoredUsers.length === 0) return null;

  return (
    <SettingsCard heading="Blocked Users">
      {isError ? (
        <SettingTile
          title={<span className="text-destructive">Couldn't load blocked users</span>}
          description={String(error)}
        />
      ) : ignoredUsers ? (
        ignoredUsers.map((userId) => (
          <SettingTile
            key={userId}
            title={userId}
            control={
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleUnblock(userId)}
                disabled={pendingUserIds.size > 0}
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
