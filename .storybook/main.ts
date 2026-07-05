import type { StorybookConfig } from "@storybook/react-vite";

// Stories live next to the components they document (src/components/ui/*.stories.tsx).
// The @ alias and the @tailwindcss/vite plugin come from the project's vite.config.ts,
// which @storybook/builder-vite loads and merges automatically.
const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-a11y"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
};

export default config;
