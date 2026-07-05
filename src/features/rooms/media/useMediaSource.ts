import { convertFileSrc } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";
import { resolveMedia } from "@/lib/matrix";

/**
 * Resolves the media attached to `(roomId, eventId)` to a webview-loadable
 * URL, via `resolve_media` (re-derives the real `MediaSource` server-side,
 * fetches/decrypts/caches in Rust) + `convertFileSrc` (Tauri's asset-protocol
 * URL for a local path — see the `assetProtocol.scope` entry for
 * `$APPDATA/media/**` in `tauri.conf.json`).
 *
 * Keyed by `(roomId, eventId, thumbnail)` in TanStack Query's cache, so
 * multiple components rendering the same event (e.g. a thumbnail in the
 * timeline and the same image reopened in a lightbox) share one
 * `resolve_media` call rather than each triggering their own fetch/decrypt.
 */
export function useMediaSource(
  roomId: string | null | undefined,
  eventId: string | null | undefined,
  options?: { thumbnail?: boolean },
) {
  const thumbnail = options?.thumbnail ?? false;

  return useQuery({
    queryKey: ["media", roomId, eventId, thumbnail],
    queryFn: async () => {
      if (!roomId || !eventId) throw new Error("no room/event id for media");
      const path = await resolveMedia(roomId, eventId, thumbnail);
      return convertFileSrc(path);
    },
    enabled: Boolean(roomId) && Boolean(eventId),
    // Not Infinity: the Rust-side filesystem cache this resolves to enforces
    // its own 7-day/500MB LRU eviction, so a path resolved long ago can go
    // stale. A bounded staleTime/gcTime lets a long-lived session eventually
    // re-resolve, and lets React Query actually garbage-collect entries for
    // events no longer on screen, instead of holding every resolved path
    // for the lifetime of the app.
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}
