import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getPushStatus,
  onPushStatus,
  registerPush,
  unregisterPush,
  type PushStatus,
} from "@/lib/matrix";

const PUSH_STATUS_QUERY_KEY = ["pushStatus"] as const;

/**
 * Transport/registration state (Spec 11) for the notifications settings
 * panel: a one-shot fetch on mount plus a live `push:status` subscription
 * (fired by `register_push`/`unregister_push` and by a platform transport
 * re-registering on its own, e.g. after a token rotation), and the
 * register/unregister actions themselves.
 *
 * On desktop, `getPushStatus`/`registerPush` both resolve to
 * `{ transport: "none", registered: false, endpoint_present: false }` — see
 * `push::active_transport`'s doc comment — so this hook is safe to mount
 * unconditionally regardless of platform.
 */
export function usePush() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unlisten = onPushStatus((status: PushStatus) => {
      queryClient.setQueryData(PUSH_STATUS_QUERY_KEY, status);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
    };
  }, [queryClient]);

  const status = useQuery({
    queryKey: PUSH_STATUS_QUERY_KEY,
    queryFn: getPushStatus,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: PUSH_STATUS_QUERY_KEY });

  const register = useMutation({
    mutationFn: registerPush,
    onSuccess: invalidate,
  });
  const unregister = useMutation({
    mutationFn: unregisterPush,
    onSuccess: invalidate,
  });

  return { status: status.data, register, unregister };
}
