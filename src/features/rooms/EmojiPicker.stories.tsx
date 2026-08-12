import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { EmojiPickerPanel } from "./EmojiPicker";

const CUSTOM_EMOJI_DATA_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%237c3aed'/%3E%3Ctext x='32' y='43' text-anchor='middle' font-size='34' font-family='sans-serif' fill='white'%3EC%3C/text%3E%3C/svg%3E";

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

/** Day-2 custom emoji packs enter through the same shared picker seam. */
export const WithCustomEmoji: Story = {
  args: {
    extraCategories: [
      {
        id: "cloudhub",
        name: "CloudHub",
        emojis: [
          {
            id: "charm-logo",
            names: ["charm", "logo"],
            imgUrl: CUSTOM_EMOJI_DATA_URL,
          },
        ],
      },
    ],
  },
};
