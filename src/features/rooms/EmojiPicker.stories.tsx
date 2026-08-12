import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { EmojiPickerPanel } from "./EmojiPicker";

const meta = {
  title: "Rooms/EmojiPicker",
  component: EmojiPickerPanel,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: { onSelect: fn() },
} satisfies Meta<typeof EmojiPickerPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Full searchable Unicode picker with categories, recent emoji, and skin tones. */
export const FullPicker: Story = {};
