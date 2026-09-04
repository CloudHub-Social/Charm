import { useAtomValue } from "jotai";
import { useFlag } from "@/featureFlags";
import { clockFormatAtom, dateFormatAtom } from "./atoms";

/** Keep saved preferences dormant when the rollout is disabled. */
export function useDisplayFormats() {
  const enabled = useFlag("appearance_parity");
  const clockFormat = useAtomValue(clockFormatAtom);
  const dateFormat = useAtomValue(dateFormatAtom);
  return {
    clockFormat: enabled ? clockFormat : ("locale" as const),
    dateFormat: enabled ? dateFormat : ("locale" as const),
  };
}
