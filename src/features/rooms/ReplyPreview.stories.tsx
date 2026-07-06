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
  sender_display_name: "Alice Anderson",
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

const unresolvedReply = {
  event_id: "$original:localhost",
  sender: "",
  sender_display_name: null,
  preview: "",
};

/** The replied-to event hasn't resolved yet (outside the loaded window, or still fetching) — see `timeline.rs`'s `ReplyRef` mapping. */
export const UnresolvedQuote: Story = {
  args: {
    reply: unresolvedReply,
    variant: "quote",
    onClick: () => {},
  },
};

export const UnresolvedComposerReplyBar: Story = {
  args: {
    reply: unresolvedReply,
    variant: "composer",
    onCancel: () => {},
  },
};
