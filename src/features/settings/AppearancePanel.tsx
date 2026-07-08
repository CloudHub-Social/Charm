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
    setTheme,
    setFontSize,
    setDensity,
    setReducedMotion,
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
      </SettingsCard>
    </div>
  );
}
