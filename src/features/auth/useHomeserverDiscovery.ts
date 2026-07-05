import { useEffect, useRef, useState } from "react";
import { discoverHomeserver } from "@/lib/matrix";

const DEBOUNCE_MS = 500;

export type DiscoveryStatus =
  | { state: "idle" }
  | { state: "resolving" }
  | { state: "resolved"; homeserverUrl: string }
  | { state: "failed" };

/**
 * Debounced `.well-known/matrix/client` discovery for live feedback on the
 * homeserver field, so a bare server name like "matrix.org" shows the actual
 * URL it resolves to before the user submits. Failures are swallowed into a
 * "failed" status rather than surfaced as an error — an unresolvable name is
 * expected while the user is still typing, and the real error surfaces from
 * the login/register call itself.
 */
export function useHomeserverDiscovery(input: string): DiscoveryStatus {
  const [status, setStatus] = useState<DiscoveryStatus>({ state: "idle" });
  const requestIdRef = useRef(0);

  useEffect(() => {
    const trimmed = input.trim();
    if (!trimmed) {
      setStatus({ state: "idle" });
      return undefined;
    }

    setStatus({ state: "resolving" });
    const requestId = ++requestIdRef.current;

    const timer = setTimeout(() => {
      discoverHomeserver(trimmed)
        .then((response) => {
          if (requestIdRef.current === requestId) {
            setStatus({ state: "resolved", homeserverUrl: response.homeserver_url });
          }
        })
        .catch(() => {
          if (requestIdRef.current === requestId) {
            setStatus({ state: "failed" });
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      // Invalidate this request so a response that arrives after cleanup
      // (input changed, or the component unmounted) is ignored — guards an
      // in-flight `discoverHomeserver` call that already started, not just
      // ones still waiting out the debounce.
      if (requestIdRef.current === requestId) {
        requestIdRef.current += 1;
      }
    };
  }, [input]);

  return status;
}
