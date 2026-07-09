import { convertFileSrc } from "@tauri-apps/api/core";
import { isWebBuild } from "./platform";

const LOADABLE_URL_PATTERN = /^(?:https?|asset|tauri|blob|data):/;
const ROOT_RELATIVE_API_URL_PATTERN = /^\/(?:[^/?#]+\/)*api(?:[/?#]|$)/;

export function toLoadableMediaUrl(pathOrUrl: string): string | undefined {
  if (LOADABLE_URL_PATTERN.test(pathOrUrl) || ROOT_RELATIVE_API_URL_PATTERN.test(pathOrUrl)) {
    return pathOrUrl;
  }
  if (isWebBuild()) return undefined;
  return convertFileSrc(pathOrUrl);
}
