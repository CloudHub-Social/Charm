import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
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
    // The picker is lazy-loaded. Capture and accessibility checks must see
    // the interactive surface, not whichever Suspense state won a timing race.
    const search = await within(canvasElement).findByPlaceholderText(
      "Search emoji",
      {},
      { timeout: 10000 },
    );
    await expect(search).toBeVisible();
    await waitFor(() => expect(search).not.toHaveAttribute("aria-controls"));
    await userEvent.type(search, "smile");
    await waitFor(() => {
      expect(search).toHaveAttribute("aria-controls", "epr-search-id");
      expect(canvasElement.querySelector('[id="epr-search-id"]')).not.toBeNull();
    });
    await userEvent.clear(search);
    await waitFor(() => expect(search).not.toHaveAttribute("aria-controls"));
  },
};
