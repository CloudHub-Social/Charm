import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Renders the shipped `ui` components under a given theme/density/font-size
 * combination. Doesn't rely on the toolbar globals (each story sets its own
 * combo directly via a `data-*` attribute) so `test-storybook:ci`'s axe pass
 * exercises every combination without needing toolbar interaction —
 * catching token regressions per Charm 2.0 Spec 09's acceptance criteria
 * (WCAG AA across all three themes).
 */
function ComponentGallery({
  theme,
  density,
  fontSize,
}: {
  theme: "dark" | "light" | "midnight";
  density: "compact" | "cozy";
  fontSize: "sm" | "md" | "lg" | "xl";
}) {
  useEffect(() => {
    const root = document.documentElement;
    // `Object.assign({}, ...)` rather than `{ ...root.dataset }`: DOMStringMap
    // is a host-object instance, and oxlint's no-misused-spread rule flags
    // spreading it (loses its prototype) — Object.assign copies the same
    // enumerable own properties without tripping that rule.
    const prev = Object.assign({}, root.dataset);
    root.dataset.theme = theme;
    root.dataset.density = density;
    root.dataset.fontSize = fontSize;
    return () => {
      Object.assign(root.dataset, prev);
    };
  }, [theme, density, fontSize]);

  return (
    <div className="flex max-w-sm flex-col gap-4 rounded-lg border border-border bg-background p-6">
      <div className="flex flex-wrap gap-2">
        <Button>Default</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="link">Link</Button>
        <Button variant="destructive">Destructive</Button>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`themes-story-input-${theme}`}>Display name</Label>
        <Input id={`themes-story-input-${theme}`} placeholder="Type something…" />
        <Input placeholder="Disabled" disabled />
      </div>
      <div className="flex items-center gap-3">
        <Avatar>
          <AvatarFallback>CH</AvatarFallback>
        </Avatar>
        <span className="text-sm text-foreground">Primary text</span>
        <span className="text-sm text-muted-foreground">Muted text</span>
      </div>
    </div>
  );
}

const meta = {
  title: "Design system/Themes",
  component: ComponentGallery,
  tags: ["autodocs"],
} satisfies Meta<typeof ComponentGallery>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Dark: Story = { args: { theme: "dark", density: "cozy", fontSize: "md" } };
export const Light: Story = { args: { theme: "light", density: "cozy", fontSize: "md" } };
export const Midnight: Story = { args: { theme: "midnight", density: "cozy", fontSize: "md" } };
export const DarkCompact: Story = { args: { theme: "dark", density: "compact", fontSize: "md" } };
export const LightCompact: Story = { args: { theme: "light", density: "compact", fontSize: "md" } };
export const DarkLargeText: Story = { args: { theme: "dark", density: "cozy", fontSize: "xl" } };
export const LightLargeText: Story = { args: { theme: "light", density: "cozy", fontSize: "xl" } };
