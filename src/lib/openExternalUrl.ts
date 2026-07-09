import { openUrl } from "@tauri-apps/plugin-opener";
import { isWebBuild } from "./platform";

function isSafeWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.protocol === "mailto:" ||
      parsed.protocol === "tel:"
    );
  } catch {
    return false;
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  if (isWebBuild()) {
    if (!isSafeWebUrl(url)) return;
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await openUrl(url);
}
