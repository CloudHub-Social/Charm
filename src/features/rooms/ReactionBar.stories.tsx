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

const compactReactions = [
  "👍",
  "🎉",
  "❤️",
  "🔥",
  "👀",
  "✅",
  "🌟",
  "🎈",
  "💜",
  "😊",
  "🙌",
  "🚀",
  "🍀",
  "☀️",
  "🌈",
  "🎵",
  "💡",
  "👏",
  "🤔",
  "💯",
].map((key, index) => ({
  key,
  count: index + 1,
  reacted_by_me: index === 0,
}));

export const CompactOne: Story = {
  args: { reactions: compactReactions.slice(0, 1), onToggle: () => {} },
  decorators: [
    (Story) => (
      <div style={{ width: 220 }}>
        <Story />
      </div>
    ),
  ],
};

export const CompactFive: Story = {
  ...CompactOne,
  args: { reactions: compactReactions.slice(0, 5), onToggle: () => {} },
};

export const CompactTwenty: Story = {
  ...CompactOne,
  args: { reactions: compactReactions, onToggle: () => {} },
};
