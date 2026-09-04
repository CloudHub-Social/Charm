/** Fixed local font stacks: preferences never supply CSS or remote URLs. */
export const FONT_FAMILIES = {
  default: {
    label: "Charm default",
    stack: '"Manrope", system-ui, -apple-system, "Segoe UI", sans-serif',
  },
  system: { label: "System UI", stack: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
  sans: { label: "Sans serif", stack: "Arial, Helvetica, sans-serif" },
  serif: { label: "Serif", stack: 'Georgia, "Times New Roman", serif' },
  mono: { label: "Monospace", stack: 'ui-monospace, "SFMono-Regular", Consolas, monospace' },
} as const;

export type FontFamily = keyof typeof FONT_FAMILIES;
export const FONT_FAMILY_KEYS = Object.keys(FONT_FAMILIES) as FontFamily[];
export const FONT_FAMILY_LABELS = Object.fromEntries(
  FONT_FAMILY_KEYS.map((key) => [key, FONT_FAMILIES[key].label]),
) as Record<FontFamily, string>;
