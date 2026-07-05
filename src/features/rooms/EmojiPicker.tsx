import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * A minimal, hardcoded emoji grid — no emoji-mart, no search/autocomplete
 * (that's a later spec). Deliberately small: just enough common reactions
 * to cover the Spec 03 "minimal emoji picker" requirement.
 */
const COMMON_EMOJI = [
  "👍",
  "👎",
  "❤️",
  "😂",
  "😮",
  "😢",
  "😡",
  "🎉",
  "🙏",
  "👀",
  "🔥",
  "✅",
  "❌",
  "💯",
  "🤔",
  "😍",
  "🚀",
  "👏",
  "😅",
  "🥳",
  "😴",
  "🤝",
  "😎",
  "🤯",
  "🫡",
  "😭",
  "🙌",
  "💀",
  "🤷",
  "✨",
  "🍕",
  "☕",
  "🐛",
  "⚡",
  "🎯",
  "📌",
  "🔒",
  "🔧",
  "💡",
  "🧠",
];

interface EmojiPickerProps {
  children: ReactNode;
  onSelect: (emoji: string) => void;
}

export function EmojiPicker({ children, onSelect }: EmojiPickerProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        <div className="grid grid-cols-8 gap-1">
          {COMMON_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onSelect(emoji)}
              aria-label={`React with ${emoji}`}
              className="flex size-7 items-center justify-center rounded-md text-base hover:bg-secondary"
            >
              {emoji}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
