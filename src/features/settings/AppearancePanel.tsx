import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Density, FontSize, ReducedMotion, Theme } from "@/features/appearance/atoms";
import { useAppearance } from "@/features/appearance/useAppearance";

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

function PickerRow<T extends string>({
  label,
  value,
  labels,
  onChange,
}: {
  label: string;
  value: T;
  labels: Record<T, string>;
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-foreground">{label}</span>
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
    </div>
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
    setTheme,
    setFontSize,
    setDensity,
    setReducedMotion,
  } = useAppearance();

  return (
    <div className="max-w-md">
      <h2 className="mb-2 text-lg font-bold text-foreground">Appearance</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Changes apply immediately and are remembered on this device.
      </p>
      <div className="divide-y divide-border">
        <PickerRow label="Theme" value={theme} labels={THEME_LABELS} onChange={setTheme} />
        <PickerRow
          label="Font size"
          value={fontSize}
          labels={FONT_SIZE_LABELS}
          onChange={setFontSize}
        />
        <PickerRow
          label="Message density"
          value={density}
          labels={DENSITY_LABELS}
          onChange={setDensity}
        />
        <PickerRow
          label="Motion"
          value={reducedMotion}
          labels={REDUCED_MOTION_LABELS}
          onChange={setReducedMotion}
        />
      </div>
    </div>
  );
}
