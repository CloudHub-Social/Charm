import { convertFileSrc } from "@tauri-apps/api/core";

const AVATAR_COLORS = [
  "var(--color-accent)",
  "var(--color-warning)",
  "var(--color-success)",
  "var(--color-danger)",
  "var(--color-text-muted)",
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
  return path ? convertFileSrc(path) : undefined;
}
