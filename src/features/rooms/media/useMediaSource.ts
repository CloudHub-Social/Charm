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
    // Not Infinity: the Rust-side filesystem cache this resolves to enforces
    // its own 7-day/500MB LRU eviction, so a path resolved long ago can go
    // stale. A bounded staleTime/gcTime lets a long-lived session eventually
    // re-resolve, and lets React Query actually garbage-collect entries for
    // handles no longer on screen, instead of holding every resolved path
    // for the lifetime of the app.
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}
