import { openUrl } from "@tauri-apps/plugin-opener";
import { isWebBuild } from "./platform";

export async function openExternalUrl(url: string): Promise<void> {
  if (isWebBuild()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await openUrl(url);
}
