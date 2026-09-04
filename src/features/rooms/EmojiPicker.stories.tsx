import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn, within } from "storybook/test";
import { EmojiPickerPanel } from "./EmojiPicker";

const meta = {
  title: "Rooms/EmojiPicker",
  component: EmojiPickerPanel,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: { accountId: "@storybook:example.org", onSelect: fn() },
} satisfies Meta<typeof EmojiPickerPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Full searchable Unicode picker with categories, recent emoji, and skin tones. */
export const FullPicker: Story = {
  async play({ canvasElement }) {
    // Wait for the lazy-loaded picker, not its Suspense placeholder, before
    // accessibility checks and visual capture run in postVisit.
    await within(canvasElement).findByPlaceholderText("Search emoji", {}, { timeout: 10000 });
  },
};
