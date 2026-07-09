import { toLoadableMediaUrl } from "@/lib/mediaUrl";
import { isWebBuild } from "@/lib/platform";

// Solid-fill variants (not --color-accent/-warning/-success/-danger/
// -text-muted directly): every avatar fallback pairs one of these
// background colors with fixed white initials text (see AvatarFallback's
// `text-white`) — the canvas-tuned semantic tokens are calibrated for text/
// border/ring contexts on a themed background, not for a solid fill under
// unconditionally-white text, and several fall well under the 4.5:1 WCAG AA
// floor there (e.g. success-500 at 2.13-2.27:1, gray-400/gray-300 at
// 2.15-3.09:1). See tokens.css's --primary-solid/-destructive-solid/
// -success-solid/-warning-solid/-muted-solid definitions.
const AVATAR_COLORS = [
  "var(--primary-solid)",
  "var(--warning-solid)",
  "var(--success-solid)",
  "var(--destructive-solid)",
  "var(--muted-solid)",
];

function hash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) - h + input.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

export function displayName(roomId: string, name: string | null): string {
  return name ?? roomId;
}

export function initials(roomId: string, name: string | null): string {
  const label = displayName(roomId, name).replace(/^[#@]/, "");
  return label.slice(0, 2).toUpperCase();
}

export function avatarColor(roomId: string): string {
  return AVATAR_COLORS[hash(roomId) % AVATAR_COLORS.length];
}

function webApiUrl(path: string): string {
  const configured = import.meta.env.VITE_CHARM_WEB_API_BASE_URL;
  const base = configured?.replace(/\/+$/, "") ?? "";
  return `${base}${path}`;
}

/**
 * Turns a backend-resolved local avatar thumbnail path, or a web companion
 * resolver URL built from the avatar's `mxc://` URI, into a loadable image URL.
 * Returns `undefined` when there's neither value, so callers fall back to the
 * initials avatar rather than rendering a broken image.
 */
export function resolveAvatar(path: string | null, mxcUrl?: string | null): string | undefined {
  if (path) return toLoadableMediaUrl(path);
  return isWebBuild() && mxcUrl
    ? toLoadableMediaUrl(webApiUrl(`/api/media/avatar?mxc=${encodeURIComponent(mxcUrl)}`))
    : undefined;
}
