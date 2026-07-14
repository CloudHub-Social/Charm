import { cn } from "@/lib/utils";

export interface AutocompleteItem {
  key: string;
  label: string;
  sublabel?: string;
  leading?: string;
}

export interface AutocompletePosition {
  top: number;
  left: number;
}

interface AutocompletePopoverProps {
  items: AutocompleteItem[];
  activeIndex: number;
  onSelect: (index: number) => void;
  /** Viewport-relative position (from the trigger character's `clientRect`). */
  position: AutocompletePosition;
}

/**
 * The single floating list every `suggestion`-driven provider (slash
 * commands, emoji, `@`/`#` mentions) renders into — a plain absolutely
 * positioned list rather than a Radix `Popover` (whose anchor model assumes
 * a persistent trigger element, not a moving caret position inside
 * contenteditable text), per `Composer.tsx`'s `useSuggestionMenu` hook.
 */
export function AutocompletePopover({
  items,
  activeIndex,
  onSelect,
  position,
}: AutocompletePopoverProps) {
  if (items.length === 0) return null;

  return (
    <div
      role="listbox"
      aria-label="Suggestions"
      className="fixed z-50 max-h-60 w-64 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ top: position.top, left: position.left }}
    >
      {items.map((item, index) => (
        <button
          key={item.key}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          onMouseDown={(e) => {
            // Prevent the editor from losing focus/selection before the
            // click handler runs.
            e.preventDefault();
            onSelect(index);
          }}
          className={cn(
            "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
            index === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
          )}
        >
          {item.leading && <span className="w-5 shrink-0 text-center">{item.leading}</span>}
          <span className="flex-1 truncate">{item.label}</span>
          {item.sublabel && (
            <span className="shrink-0 text-xs text-muted-foreground">{item.sublabel}</span>
          )}
        </button>
      ))}
    </div>
  );
}
