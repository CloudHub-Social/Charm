import type { Meta, StoryObj } from "@storybook/react-vite";
import { Composer } from "./Composer";

const meta = {
  title: "Rooms/Composer",
  component: Composer,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof Composer>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Storybook has no Tauri host, so `getRoomMembers`/`listRooms` (called on
 * mount to seed the `@`/`#` providers) reject — the Composer already
 * `.catch(logAndIgnore)`s both, so this renders fine with empty provider
 * data; only live `@`/`#` autocomplete needs a real backend.
 */
export const Send: Story = {
  args: {
    roomId: "!story:localhost",
    mode: "send",
    placeholder: "Message general",
    onSubmit: () => {},
    onSlashCommand: () => {},
    onEscape: () => {},
    onTypingInput: () => {},
  },
};

export const EditWithFormattedContent: Story = {
  args: {
    ...Send.args,
    mode: "edit",
    initialHtml: "<p><strong>Already bold</strong> — edit me</p>",
    placeholder: "Edit message",
  },
};
