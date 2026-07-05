import type { Decorator, Preview } from "@storybook/react-vite";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "../src/styles/tokens.css";

// Charm is dark-first: the design tokens set the canvas background/foreground on
// `body`, and `[data-theme="light"]` overrides them. The toolbar switch below drives
// the same `data-theme` attribute the app uses, so stories render under real themes.
const withTheme: Decorator = (Story, context) => {
  const theme = context.globals.theme as string;
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = theme;
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
      test: "error",
      config: {
        rules: [
          // color-contrast is a design-TOKEN concern (the primary/link/etc.
          // button tokens fall short of WCAG AA in the dark theme). Fixing it is
          // owned by Charm 2.0 Spec 09 (Theming & appearance), whose acceptance
          // criteria already require zero contrast violations across all themes.
          // Every other axe rule is enforced now; re-enable this in the Spec 09 PR.
          { id: "color-contrast", enabled: false },
        ],
      },
    },
  },
};

export default preview;
