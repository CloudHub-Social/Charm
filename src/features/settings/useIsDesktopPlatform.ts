import { useQuery } from "@tanstack/react-query";
import { isDesktopPlatform } from "@/lib/matrix";
import { isTauri } from "@/lib/platform";

/**
 * Whether this build actually targets a desktop OS — Tauri's own
 * `desktop`/`mobile` compile-time distinction, not viewport width.
 * `useAdaptiveLayout`'s `mobile`/`desktop` is a `(max-width: 767px)` media
 * query, which a Tauri *mobile* build at a tablet/landscape size can satisfy
 * as "desktop" despite having none of the underlying capability (autostart
 * commands are `#[cfg(not(desktop))]` stubs there) — this checks the real
 * target instead. Defaults to `false` (hides the Desktop section) until the
 * query resolves, and short-circuits to `false` outside Tauri without an
 * IPC round trip.
 */
export function useIsDesktopPlatform(): boolean {
  const { data } = useQuery({
    queryKey: ["settings", "is-desktop-platform"],
    queryFn: isDesktopPlatform,
    enabled: isTauri(),
    staleTime: Infinity,
  });
  return data ?? false;
}
