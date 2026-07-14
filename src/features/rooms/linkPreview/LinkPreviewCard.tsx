import { useQuery } from "@tanstack/react-query";
import { resolveAvatar } from "@/lib/matrix";
import { toLoadableMediaUrl } from "@/lib/mediaUrl";
import { externalLinkProps } from "../RichMessageContent";
import { fetchUrlPreview } from "./previewCache";

interface LinkPreviewCardProps {
  roomId: string;
  url: string;
}

/** Resolves a preview's `imageUrl` (a bare `mxc://` URI per the Matrix C-S
 * API, or occasionally a direct URL depending on server behavior) to a
 * webview-loadable source, reusing the same `resolve_avatar` mxc-resolution
 * command profile avatars use — it already resolves an arbitrary `mxc://`
 * URI to a cached local thumbnail with no owning room/event required, so no
 * new resolver command is needed. `undefined` on any resolution failure,
 * so the card renders without an image rather than a broken-image icon. */
function useResolvedPreviewImageSrc(imageUrl: string | null | undefined) {
  const { data } = useQuery({
    queryKey: ["link-preview-image", imageUrl],
    queryFn: async () => {
      if (!imageUrl) return null;
      if (!imageUrl.startsWith("mxc://")) return imageUrl;
      const path = await resolveAvatar(imageUrl);
      return path ? (toLoadableMediaUrl(path) ?? null) : null;
    },
    enabled: Boolean(imageUrl),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
  return data ?? undefined;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Unfurled link-preview card (Spec 29), rendered under a message body when a
 * URL is detected and the `link_previews` feature flag is on. Renders
 * nothing when there's no preview data to show (fetch still pending isn't
 * "nothing" — it's simply not rendered until data arrives, avoiding a
 * layout-shifting placeholder for what's usually a sub-second fetch).
 */
export function LinkPreviewCard({ roomId, url }: LinkPreviewCardProps) {
  const { data: preview } = useQuery({
    queryKey: ["link-preview", roomId, url],
    queryFn: () => fetchUrlPreview(roomId, url),
    staleTime: 60 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
  });

  const imageSrc = useResolvedPreviewImageSrc(preview?.imageUrl);

  if (!preview) return null;
  if (!preview.title && !preview.description && !preview.imageUrl) return null;

  const siteName = preview.siteName ?? hostnameOf(url);

  return (
    <a
      {...externalLinkProps(url)}
      className="mt-1 flex max-w-md gap-3 rounded-md border border-border p-2 no-underline hover:bg-muted/50"
    >
      {imageSrc && (
        <img
          src={imageSrc}
          alt={preview.title ?? "Link preview thumbnail"}
          className="h-16 w-16 shrink-0 rounded object-cover"
        />
      )}
      <div className="min-w-0 flex-1">
        {siteName && <div className="truncate text-xs text-muted-foreground">{siteName}</div>}
        {preview.title && <div className="truncate font-semibold">{preview.title}</div>}
        {preview.description && (
          <div className="line-clamp-2 text-sm text-muted-foreground">{preview.description}</div>
        )}
      </div>
    </a>
  );
}
