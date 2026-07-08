import { convertFileSrc } from "@tauri-apps/api/core";

export function toLoadableMediaUrl(pathOrUrl: string): string {
  if (
    pathOrUrl.startsWith("http://") ||
    pathOrUrl.startsWith("https://") ||
    pathOrUrl.startsWith("/api/")
  ) {
    return pathOrUrl;
  }
  return convertFileSrc(pathOrUrl);
}
