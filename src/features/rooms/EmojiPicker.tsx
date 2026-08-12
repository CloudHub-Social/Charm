import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import type { EmojiClickData, PickerProps } from "emoji-picker-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useFlag } from "@/featureFlags";

const FullPicker = lazy(() => import("emoji-picker-react"));

/** One custom-emoji group supplied by a future pack provider (day-2 Spec 05). */
export interface EmojiPickerExtraCategory {
  id: string;
  name: string;
  emojis: NonNullable<PickerProps["customEmojis"]>;
}

interface EmojiPickerPanelProps {
  onSelect: (emoji: string) => void;
  extraCategories?: readonly EmojiPickerExtraCategory[];
}

/**
 * The lazy-loaded full picker surface. Exported separately so Storybook can
 * exercise the grid and its axe/keyboard checks without opening a popover.
 */
export function EmojiPickerPanel({ onSelect, extraCategories = [] }: EmojiPickerPanelProps) {
  const customEmojis = useMemo(
    () =>
      extraCategories.flatMap((category) =>
        category.emojis.map((emoji) => ({
          ...emoji,
          names: [...emoji.names, category.name, category.id],
        })),
      ),
    [extraCategories],
  );

  function select(data: EmojiClickData) {
    onSelect(data.emoji);
  }

  return (
    <Suspense
      fallback={
        <div
          className="flex h-80 w-80 items-center justify-center text-sm text-muted-foreground"
          role="status"
        >
          Loading emoji…
        </div>
      }
    >
      <FullPicker
        width="min(22rem, calc(100vw - 2rem))"
        height={420}
        theme={"auto" as PickerProps["theme"]}
        emojiStyle={"native" as PickerProps["emojiStyle"]}
        suggestedEmojisMode={"recent" as PickerProps["suggestedEmojisMode"]}
        searchPlaceholder="Search emoji"
        searchClearButtonLabel="Clear emoji search"
        lazyLoadEmojis
        customEmojis={customEmojis}
        previewConfig={{ showPreview: false }}
        onEmojiClick={select}
      />
    </Suspense>
  );
}

/** The Spec 03 fallback retained while the full picker flag is disabled. */
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

interface EmojiPickerProps extends EmojiPickerPanelProps {
  children: ReactNode;
  align?: "start" | "center" | "end";
}

/** Shared reaction/composer emoji popover with a default-off full-picker path. */
export function EmojiPicker({
  children,
  onSelect,
  extraCategories,
  align = "start",
}: EmojiPickerProps) {
  const fullPickerEnabled = useFlag("full_emoji_picker");
  const [open, setOpen] = useState(false);

  function select(emoji: string) {
    onSelect(emoji);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className={fullPickerEnabled ? "w-auto overflow-hidden p-0" : "w-64 p-2"}
        align={align}
      >
        {fullPickerEnabled ? (
          <EmojiPickerPanel onSelect={select} extraCategories={extraCategories} />
        ) : (
          <div className="grid grid-cols-8 gap-1">
            {COMMON_EMOJI.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => select(emoji)}
                aria-label={`React with ${emoji}`}
                className="flex size-7 items-center justify-center rounded-md text-base hover:bg-secondary"
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
