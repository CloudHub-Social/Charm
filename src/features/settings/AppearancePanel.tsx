import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type {
  Density,
  FontSize,
  MessageLayout,
  ReducedMotion,
  Theme,
} from "@/features/appearance/atoms";
import { useAppearance } from "@/features/appearance/useAppearance";
import { SettingsCard, SettingTile } from "./components/SettingsCard";

const THEME_LABELS: Record<Theme, string> = {
  dark: "Dark",
  light: "Light",
  midnight: "Midnight",
  system: "Match system",
};

const FONT_SIZE_LABELS: Record<FontSize, string> = {
  sm: "Small",
  md: "Medium",
  lg: "Large",
  xl: "Extra large",
};

const DENSITY_LABELS: Record<Density, string> = {
  compact: "Compact",
  cozy: "Cozy",
};

const REDUCED_MOTION_LABELS: Record<ReducedMotion, string> = {
  system: "Match system",
  on: "Reduced",
  off: "Full motion",
};

const MESSAGE_LAYOUT_LABELS: Record<MessageLayout, string> = {
  bubble: "Bubble",
  discord: "Discord",
  irc: "IRC",
};

const MESSAGE_LAYOUT_ORDER: MessageLayout[] = ["bubble", "discord", "irc"];

/** Tiny CSS-drawn preview of what each layout looks like — two stacked
 * lines standing in for two messages, shaped per mode (rounded pill for
 * bubble, flat left-aligned block for discord, single dense line for irc) —
 * cheap enough to keep inline rather than importing/rendering real message
 * components for a decorative thumbnail. */
function MessageLayoutPreview({ mode }: { mode: MessageLayout }) {
  if (mode === "bubble") {
    return (
      <svg viewBox="0 0 64 32" className="h-8 w-16" aria-hidden="true">
        <rect x="4" y="4" width="32" height="8" rx="4" className="fill-secondary" />
        <rect x="28" y="18" width="32" height="8" rx="4" className="fill-primary-solid" />
      </svg>
    );
  }
  if (mode === "discord") {
    return (
      <svg viewBox="0 0 64 32" className="h-8 w-16" aria-hidden="true">
        <circle cx="8" cy="8" r="4" className="fill-secondary" />
        <rect x="16" y="5" width="30" height="3" rx="1.5" className="fill-secondary" />
        <rect x="16" y="10" width="40" height="3" rx="1.5" className="fill-muted-foreground/40" />
        <rect x="4" y="20" width="44" height="3" rx="1.5" className="fill-muted-foreground/40" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 64 32" className="h-8 w-16" aria-hidden="true">
      <rect x="4" y="8" width="10" height="3" rx="1" className="fill-muted-foreground/40" />
      <rect x="16" y="8" width="12" height="3" rx="1" className="fill-secondary" />
      <rect x="30" y="8" width="30" height="3" rx="1" className="fill-muted-foreground/40" />
      <rect x="4" y="18" width="10" height="3" rx="1" className="fill-muted-foreground/40" />
      <rect x="16" y="18" width="10" height="3" rx="1" className="fill-secondary" />
      <rect x="28" y="18" width="24" height="3" rx="1" className="fill-muted-foreground/40" />
    </svg>
  );
}

/** Segmented control (Charm 2.0 Spec 27): three options, each with a small
 * live preview thumbnail, for the `messageLayout` appearance setting. */
function MessageLayoutControl({
  value,
  onChange,
}: {
  value: MessageLayout;
  onChange: (next: MessageLayout) => void;
}) {
  return (
    <fieldset className="flex gap-2 border-0 p-0">
      <legend className="sr-only">Message layout mode</legend>
      {MESSAGE_LAYOUT_ORDER.map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
          className={cn(
            "flex flex-col items-center gap-1 rounded-md border px-2 py-2 text-xs",
            value === mode
              ? "border-primary-solid bg-accent text-accent-foreground"
              : "border-border text-muted-foreground hover:bg-accent/50",
          )}
        >
          <MessageLayoutPreview mode={mode} />
          {MESSAGE_LAYOUT_LABELS[mode]}
        </button>
      ))}
    </fieldset>
  );
}

function PickerControl<T extends string>({
  value,
  labels,
  onChange,
}: {
  value: T;
  labels: Record<T, string>;
  onChange: (next: T) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          {labels[value]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
          {(Object.keys(labels) as T[]).map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              {labels[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Real appearance controls (Charm 2.0 Spec 09) hosted in Spec 08's Settings
 * shell. Every setter from `useAppearance` applies live (mutates
 * `data-theme`/`data-density`/`data-font-size`/`data-reduced-motion` on
 * `<html>` immediately, no reload) and persists across restart.
 */
export function AppearancePanel() {
  const {
    theme,
    fontSize,
    density,
    reducedMotion,
    messageLayout,
    setTheme,
    setFontSize,
    setDensity,
    setReducedMotion,
    setMessageLayout,
  } = useAppearance();

  return (
    <div className="max-w-md space-y-6">
      <div>
        <h1 className="mb-1 text-lg font-bold text-foreground">Appearance</h1>
        <p className="text-sm text-muted-foreground">
          Changes apply immediately and are remembered on this device.
        </p>
      </div>
      <SettingsCard>
        <SettingTile
          title="Theme"
          control={<PickerControl value={theme} labels={THEME_LABELS} onChange={setTheme} />}
        />
        <SettingTile
          title="Font size"
          control={
            <PickerControl value={fontSize} labels={FONT_SIZE_LABELS} onChange={setFontSize} />
          }
        />
        <SettingTile
          title="Message density"
          control={<PickerControl value={density} labels={DENSITY_LABELS} onChange={setDensity} />}
        />
        <SettingTile
          title="Motion"
          control={
            <PickerControl
              value={reducedMotion}
              labels={REDUCED_MOTION_LABELS}
              onChange={setReducedMotion}
            />
          }
        />
        <SettingTile
          title="Message layout"
          description="Bubble, Discord-style, or IRC-style density."
          control={<MessageLayoutControl value={messageLayout} onChange={setMessageLayout} />}
        />
      </SettingsCard>
    </div>
  );
}
