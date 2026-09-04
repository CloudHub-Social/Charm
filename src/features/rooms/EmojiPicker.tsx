import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { CategoryConfig, EmojiClickData, PickerProps } from "emoji-picker-react";
import { useAtomValue } from "jotai";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useFlag } from "@/featureFlags";
import { themeAtom, type Theme } from "@/features/appearance/atoms";
import { useRecentReactions } from "./useRecentReactions";

const FullPicker = lazy(async () => {
  const { default: Picker } = await import("emoji-picker-react");
  return {
    default: function AccessiblePicker(props: PickerProps) {
      const root = useRef<HTMLDivElement>(null);
      const resultsId = useId();
      useEffect(() => {
        // emoji-picker-react 4.19.1 points aria-controls at a status node
        // that disappears when search is empty. The filtered grid is the
        // actual controlled surface and stays mounted in both states.
        const input = root.current?.querySelector('input[aria-controls="epr-search-id"]');
        const results = root.current?.querySelector(".epr-body");
        if (!input || !results) return;
        results.id = resultsId;
        input.setAttribute("aria-controls", resultsId);
      }, [resultsId]);
      return (
        <div ref={root}>
          <Picker {...props} />
        </div>
      );
    },
  };
});

/** One custom-emoji group supplied by a future pack provider (day-2 Spec 05). */
export interface EmojiPickerExtraCategory {
  id: string;
  name: string;
  emojis: NonNullable<PickerProps["customEmojis"]>;
}

interface EmojiPickerPanelProps {
  accountId: string;
  onSelect: (emoji: string) => void;
  extraCategories?: readonly EmojiPickerExtraCategory[];
}

const NO_EXTRA_CATEGORIES: readonly EmojiPickerExtraCategory[] = [];
const UPSTREAM_RECENT_KEY = "epr_suggested";
const PICKER_CATEGORIES = [
  { category: "custom" as CategoryConfig["category"], name: "Custom Emojis" },
  { category: "smileys_people" as CategoryConfig["category"], name: "Smileys & People" },
  { category: "animals_nature" as CategoryConfig["category"], name: "Animals & Nature" },
  { category: "food_drink" as CategoryConfig["category"], name: "Food & Drink" },
  { category: "travel_places" as CategoryConfig["category"], name: "Travel & Places" },
  { category: "activities" as CategoryConfig["category"], name: "Activities" },
  { category: "objects" as CategoryConfig["category"], name: "Objects" },
  { category: "symbols" as CategoryConfig["category"], name: "Symbols" },
  { category: "flags" as CategoryConfig["category"], name: "Flags" },
] satisfies NonNullable<PickerProps["categories"]>;

function clearUpstreamRecentEmoji(): void {
  try {
    localStorage.removeItem(UPSTREAM_RECENT_KEY);
  } catch {
    // The account-scoped Charm store still works in memory when storage is unavailable.
  }
}

/** Maps Charm's four appearance choices onto the picker's three themes. */
export function emojiPickerTheme(theme: Theme): PickerProps["theme"] {
  if (theme === "system") return "auto" as PickerProps["theme"];
  if (theme === "light") return "light" as PickerProps["theme"];
  return "dark" as PickerProps["theme"];
}

/**
 * The lazy-loaded full picker surface. Exported separately so Storybook can
 * exercise the grid and its axe/keyboard checks without opening a popover.
 */
export function EmojiPickerPanel({
  accountId,
  onSelect,
  extraCategories = NO_EXTRA_CATEGORIES,
}: EmojiPickerPanelProps) {
  const theme = useAtomValue(themeAtom);
  const { recent, recordReaction } = useRecentReactions(accountId);
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

  useEffect(clearUpstreamRecentEmoji, [accountId]);

  function select(emoji: string) {
    // emoji-picker-react writes its own profile-wide recent list before this
    // callback. Charm owns recents per Matrix account, so remove that copy.
    clearUpstreamRecentEmoji();
    recordReaction(emoji);
    onSelect(emoji);
  }

  return (
    <div className="overflow-hidden rounded-lg bg-card">
      <div className="flex max-w-[min(22rem,calc(100vw-2rem))] items-center gap-1 border-b border-border px-2 py-1.5">
        <span className="mr-1 text-xs text-muted-foreground">Recent</span>
        {recent.map((emoji) => (
          <button
            key={emoji}
            type="button"
            aria-label={`Recently used ${emoji}`}
            className="flex size-7 items-center justify-center rounded-md text-base hover:bg-secondary"
            onClick={() => select(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
      <Suspense
        fallback={
          <output className="flex h-80 w-80 items-center justify-center text-sm text-muted-foreground">
            Loading emoji…
          </output>
        }
      >
        <FullPicker
          width="min(22rem, calc(100vw - 2rem))"
          height={420}
          theme={emojiPickerTheme(theme)}
          emojiStyle={"native" as PickerProps["emojiStyle"]}
          categories={PICKER_CATEGORIES}
          searchPlaceholder="Search emoji"
          searchClearButtonLabel="Clear emoji search"
          lazyLoadEmojis
          customEmojis={customEmojis}
          previewConfig={{ showPreview: false }}
          onEmojiClick={(data: EmojiClickData) => select(data.emoji)}
        />
      </Suspense>
    </div>
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
  accountId,
  onSelect,
  extraCategories,
  align = "start",
}: EmojiPickerProps) {
  const fullPickerEnabled = useFlag("full_emoji_picker");
  const [open, setOpen] = useState(false);

  function select(emoji: string) {
    onSelect(emoji);
    if (fullPickerEnabled) setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className={fullPickerEnabled ? "w-auto overflow-hidden p-0" : "w-64 p-2"}
        align={align}
        onKeyDown={(event) => {
          // Composer owns a document-level Escape shortcut for cancelling an
          // edit/reply. Escape inside this nested popover must only dismiss
          // the picker, not bubble out and cancel the surrounding composer.
          if (event.key === "Escape") event.stopPropagation();
        }}
      >
        {fullPickerEnabled ? (
          <EmojiPickerPanel
            accountId={accountId}
            onSelect={select}
            extraCategories={extraCategories}
          />
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
