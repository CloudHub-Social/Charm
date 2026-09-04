import { useAtomValue } from "jotai";
import { useFlag } from "@/featureFlags";
import { messageSpacingAtom } from "./atoms";

export const MESSAGE_SPACING_LABELS = {
  "0": "Layout default",
  "2": "Extra small",
  "4": "Small",
  "8": "Medium",
  "12": "Large",
  "16": "Extra large",
} as const;
export type MessageSpacing = keyof typeof MESSAGE_SPACING_LABELS;

/** Additional space between rows; never reduces touch targets or bubble padding. */
export function useMessageSpacing() {
  const enabled = useFlag("appearance_parity");
  const spacing = useAtomValue(messageSpacingAtom);
  return enabled && spacing !== "0" ? { marginBottom: `${spacing}px` } : undefined;
}
