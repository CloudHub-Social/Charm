import { toLoadableMediaUrl } from "@/lib/mediaUrl";

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

/**
 * Turns a backend-resolved local avatar thumbnail path into a webview-loadable
 * URL via `convertFileSrc` (Tauri's asset-protocol URL for a local path).
 * Returns `undefined` when there's no path (no avatar set, or Spec 02's media
 * cache unavailable), so callers fall back to the initials avatar rather than
 * rendering a broken image.
 */
export function resolveAvatar(path: string | null): string | undefined {
  return path ? toLoadableMediaUrl(path) : undefined;
}
