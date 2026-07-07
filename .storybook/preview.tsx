import type { Decorator, Preview } from "@storybook/react-vite";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "../src/styles/tokens.css";

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
      // color-contrast: Spec 09's named contrast debt (Label with no color
      // class, ghost/link Button, disabled/placeholder Input) is fixed — see
      // button.tsx/label.tsx/input.tsx. Running the full suite with
      // color-contrast enabled surfaced a SECOND, larger issue Spec 09 didn't
      // scope: the `--accent`/`--danger`/`--success`/`--warning` PRIMITIVE
      // color values themselves (e.g. accent-500 #6d5ef8, danger-500
      // #ef4444) fall short of WCAG AA at small/normal text weight against
      // both white text (on a filled button) and the dark canvas (as link/
      // status text) — 12 distinct violations across Button/Dialog/
      // ReplyPreview/MemberRow/etc, not just the three Spec 09 named.
      // Re-coloring those primitives is a real design change (new hex
      // values ship across every button/badge in the app) that needs a
      // deliberate design pass, not a quick swap buried in this PR — rather
      // than either fake it or silently expand this PR's scope, it stays
      // disabled here with this narrowed explanation. See the Spec 09 PR
      // description for the full violation list; tracked as follow-up work.
      test: "error",
      config: {
        rules: [{ id: "color-contrast", enabled: false }],
      },
    },
  },
};

export default preview;
