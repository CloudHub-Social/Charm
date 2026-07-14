import type { Decorator, Preview } from "@storybook/react-vite";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "../src/styles/tokens.css";
import { featureFlagTestHooks } from "../src/featureFlags";

// Stories document shipped UI states, including features that default off
// while they are being staged for rollout.
featureFlagTestHooks.setCache({ rich_message_rendering: true });

// Charm is dark-first: the design tokens set the canvas background/foreground on
// `body`, and `src/styles/tokens.css` keys its theme overrides off `[data-theme]`.
// This toolbar switch drives that same attribute (plus density/font-size, Charm 2.0
// Spec 09) so each story can be previewed under any combination.
const withTheme: Decorator = (Story, context) => {
  const theme = typeof context.globals.theme === "string" ? context.globals.theme : "dark";
  const density = typeof context.globals.density === "string" ? context.globals.density : "cozy";
  const fontSize = typeof context.globals.fontSize === "string" ? context.globals.fontSize : "md";
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density = density;
    document.documentElement.dataset.fontSize = fontSize;
  }
  return (
    <div className="p-6 text-foreground" style={{ fontFamily: "var(--font-sans)" }}>
      <Story />
    </div>
  );
};

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Design-system theme",
      defaultValue: "dark",
      toolbar: {
        title: "Theme",
        icon: "paintbrush",
        items: [
          { value: "dark", title: "Dark" },
          { value: "light", title: "Light" },
          { value: "midnight", title: "Midnight" },
        ],
        dynamicTitle: true,
      },
    },
    density: {
      description: "Message density",
      defaultValue: "cozy",
      toolbar: {
        title: "Density",
        icon: "component",
        items: [
          { value: "cozy", title: "Cozy" },
          { value: "compact", title: "Compact" },
        ],
        dynamicTitle: true,
      },
    },
    fontSize: {
      description: "Font size",
      defaultValue: "md",
      toolbar: {
        title: "Font size",
        icon: "type",
        items: [
          { value: "sm", title: "Small" },
          { value: "md", title: "Medium" },
          { value: "lg", title: "Large" },
          { value: "xl", title: "Extra large" },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [withTheme],
  parameters: {
    controls: {
      matchers: { color: /(background|color)$/i, date: /Date$/i },
    },
    a11y: {
      // Blocking in CI: the Storybook test-runner fails on any axe violation
      // (see the `storybook-a11y` job in .github/workflows/quality-checks.yml).
      //
      // color-contrast is fully enabled and passing (0 violations, 88/88
      // stories) across all three themes — Spec 09's acceptance criterion 9.
      // This took two passes: it was disabled through most of the PR,
      // re-enabled once during review with only the three originally-named
      // components fixed (Label/ghost+link Button/Input — see button.tsx/
      // label.tsx/input.tsx), which surfaced a second, larger wave of real
      // violations in the color primitives themselves. All fixed in
      // tokens.css unless noted:
      //  - danger/success/warning were tuned for the dark canvas only
      //    (8-9:1) and fell to 2-3.8:1 against the light theme's
      //    white/gray-50 — added a light-theme override.
      //  - accent-500 as normal-size link/message text read 4.1-4.34:1
      //    against dark's own surfaces and 4.26-4.56:1 against light's —
      //    borderline-to-failing in both directions. Added per-theme
      //    --color-accent overrides (lighter for dark, darker for light;
      //    midnight already had its own).
      //  - gray-400/gray-500 (feeding --color-text-muted) read 3.96:1/
      //    4.49:1 against their themes' raised/overlay surfaces — nudged
      //    both primitives (kept the same hue; each is consumed by exactly
      //    one theme so this doesn't ripple elsewhere).
      //  - a THIRD wave, specific to solid-fill UI (colored background +
      //    fixed white/near-white text): a single token value can't be both
      //    "readable as themed text on the canvas" and "readable as white
      //    text on a solid fill" — the constraints pull in opposite
      //    directions. Rather than compromise the text-on-canvas values,
      //    added dedicated *-solid tokens (--primary-solid,
      //    --destructive-solid, --success-solid, --warning-solid,
      //    --muted-solid) used only by solid-fill contexts: Button's
      //    default/destructive variants, Avatar's badge, RoomListItem's
      //    unread badge, ChatShell's send button, MessageRow's own-message
      //    bubble, Input's text selection, and avatarColor()'s hash palette
      //    (roomDisplay.ts) feeding every Avatar fallback's background.
      //  - MemberRow.tsx's AvatarFallback set a colorful `backgroundColor`
      //    but never overrode the default `text-muted-foreground` class —
      //    a genuine component bug (~1.5:1), not a token issue — added
      //    `text-white`.
      //  - FileChip.tsx's loading state dimmed the whole chip
      //    (`opacity-70`), which also dimmed the already-borderline
      //    `text-muted-foreground` file-size text below AA — removed the
      //    opacity, kept `pointer-events-none` (the spinner already
      //    communicates the not-yet-interactive state).
      test: "error",
    },
  },
};

export default preview;
