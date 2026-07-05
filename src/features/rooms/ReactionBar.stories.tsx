import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReactionBar } from "./ReactionBar";

const meta = {
  title: "Rooms/ReactionBar",
  component: ReactionBar,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta<typeof ReactionBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: {
    reactions: [],
    onToggle: () => {},
  },
};

export const WithReactions: Story = {
  args: {
    reactions: [
      { key: "👍", count: 3, reacted_by_me: false },
      { key: "🎉", count: 1, reacted_by_me: true },
      { key: "❤️", count: 2, reacted_by_me: false },
    ],
    onToggle: () => {},
  },
};

export const OwnReactionHighlighted: Story = {
  args: {
    reactions: [{ key: "🔥", count: 1, reacted_by_me: true }],
    onToggle: () => {},
  },
};
