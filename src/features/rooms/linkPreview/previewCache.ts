import { getUrlPreview } from "@/lib/matrix";
import type { UrlPreview } from "@bindings/UrlPreview";

/**
 * Fetches a preview for `url` in `roomId`. Caching (including a cached "no
 * preview" `null`, and per-account invalidation on logout via
 * `queryClient.clear()` in `App.tsx`) is owned entirely by the TanStack
 * Query cache in `LinkPreviewCard` — this used to also keep its own
 * module-level `Map`, but two uncoordinated caches could serve stale/
 * cross-account data when one was invalidated and the other wasn't. Query
 * already dedupes by the `["link-preview", roomId, url]` key, so a second
 * cache here bought nothing.
 */
export async function fetchUrlPreview(
  roomId: string,
  url: string,
  eventTsMs?: number | null,
): Promise<UrlPreview | null> {
  return getUrlPreview(roomId, url, eventTsMs);
}
