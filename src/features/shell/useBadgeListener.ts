import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { onBadgeUpdate } from "@/lib/matrix";
import { badgeAtom, badgeUpdateValue } from "./badgeAtom";
import { logAndIgnore } from "@/lib/logAndIgnore";

/**
 * Subscribes to `badge:update` once per app (mount alongside the other
 * `on*Update` listeners in `RoomsScreen`) and feeds `badgeAtom` from it.
 */
export function useBadgeListener() {
  const setBadge = useSetAtom(badgeAtom);

  useEffect(() => {
    const unlisten = onBadgeUpdate((update) => {
      setBadge(badgeUpdateValue(update));
    });
    return () => {
      unlisten.then((fn) => fn()).catch(logAndIgnore);
    };
  }, [setBadge]);
}
