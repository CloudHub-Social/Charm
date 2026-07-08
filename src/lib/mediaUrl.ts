import { convertFileSrc } from "@tauri-apps/api/core";

const LOADABLE_URL_PATTERN = /^(?:https?|asset|tauri|blob|data):/;

export function toLoadableMediaUrl(pathOrUrl: string): string {
  if (LOADABLE_URL_PATTERN.test(pathOrUrl) || pathOrUrl.startsWith("/api/")) {
    return pathOrUrl;
  }
  return convertFileSrc(pathOrUrl);
}
