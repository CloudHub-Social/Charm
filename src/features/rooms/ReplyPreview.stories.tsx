import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReplyPreview } from "./ReplyPreview";

const meta = {
  title: "Rooms/ReplyPreview",
  component: ReplyPreview,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta<typeof ReplyPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

const reply = {
  event_id: "$original:localhost",
  sender: "@alice:localhost",
  preview: "Let's meet at 3pm to review the design",
};

export const QuoteAboveBubble: Story = {
  args: {
    reply,
    variant: "quote",
    onClick: () => {},
  },
};

export const ComposerReplyBar: Story = {
  args: {
    reply,
    variant: "composer",
    onCancel: () => {},
  },
};
