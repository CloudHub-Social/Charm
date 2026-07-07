import { useEffect, useRef } from "react";
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
  // Set by the `push:status` listener while a `getPushStatus` fetch is
  // in flight (e.g. a concurrent `register_push` call, or an Android
  // endpoint-rotation re-registration racing the initial mount fetch) —
  // that push is strictly more current than this fetch's own result, so
  // the queryFn below must not let it clobber what the listener just wrote.
  const pushedWhileFetchingRef = useRef(false);

  useEffect(() => {
    const unlisten = onPushStatus((status: PushStatus) => {
      pushedWhileFetchingRef.current = true;
      queryClient.setQueryData(PUSH_STATUS_QUERY_KEY, status);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
    };
  }, [queryClient]);

  const status = useQuery({
    queryKey: PUSH_STATUS_QUERY_KEY,
    queryFn: async () => {
      pushedWhileFetchingRef.current = false;
      const fetched = await getPushStatus();
      if (pushedWhileFetchingRef.current) {
        return queryClient.getQueryData<PushStatus>(PUSH_STATUS_QUERY_KEY) ?? fetched;
      }
      return fetched;
    },
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
