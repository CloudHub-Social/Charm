import { convertFileSrc } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { resolveMedia } from "@/lib/matrix";

/**
 * Resolves a `MediaHandle` (from a `MessageContent` media variant) to a
 * webview-loadable URL, via `resolve_media` (fetch/decrypt/cache in Rust) +
 * `convertFileSrc` (Tauri's asset-protocol URL for a local path — see the
 * `assetProtocol.scope` entry for `$APPDATA/media/**` in `tauri.conf.json`).
 *
 * Keyed by `(handle, thumbnail)` in TanStack Query's cache, so multiple
 * components rendering the same handle (e.g. a thumbnail in the timeline and
 * the same image reopened in a lightbox) share one `resolve_media` call
 * rather than each triggering their own fetch/decrypt.
 */
export function useMediaSource(
  handle: string | null | undefined,
  options?: { thumbnail?: boolean },
) {
  const thumbnail = options?.thumbnail ?? false;

  return useQuery({
    queryKey: ["media", handle, thumbnail],
    queryFn: async () => {
      if (!handle) throw new Error("no media handle");
      const path = await resolveMedia(handle, thumbnail);
      return convertFileSrc(path);
    },
    enabled: Boolean(handle),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}
