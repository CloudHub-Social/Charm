import type { Meta, StoryObj } from "@storybook/react-vite";
import { AutocompletePopover } from "./AutocompletePopover";

const meta = {
  title: "Rooms/AutocompletePopover",
  component: AutocompletePopover,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta<typeof AutocompletePopover>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SlashCommands: Story = {
  args: {
    items: [
      { key: "me", label: "/me", sublabel: "<action>", leading: "/" },
      { key: "topic", label: "/topic", sublabel: "<topic>", leading: "/" },
      { key: "invite", label: "/invite", sublabel: "<user id>", leading: "/" },
    ],
    activeIndex: 0,
    onSelect: () => {},
    position: { top: 0, left: 0 },
  },
  decorators: [
    (Story) => (
      <div style={{ position: "relative", height: 200, width: 280 }}>
        <Story />
      </div>
    ),
  ],
};

export const UserMentions: Story = {
  args: {
    items: [
      { key: "@alice:localhost", label: "Alice", sublabel: "@alice:localhost" },
      { key: "@bob:localhost", label: "Bob", sublabel: "@bob:localhost" },
    ],
    activeIndex: 1,
    onSelect: () => {},
    position: { top: 0, left: 0 },
  },
  decorators: [
    (Story) => (
      <div style={{ position: "relative", height: 200, width: 280 }}>
        <Story />
      </div>
    ),
  ],
};

export const Emoji: Story = {
  args: {
    items: [
      { key: "smile", label: ":smile:", leading: "😄" },
      { key: "smiley", label: ":smiley:", leading: "😃" },
    ],
    activeIndex: 0,
    onSelect: () => {},
    position: { top: 0, left: 0 },
  },
  decorators: [
    (Story) => (
      <div style={{ position: "relative", height: 200, width: 280 }}>
        <Story />
      </div>
    ),
  ],
};
