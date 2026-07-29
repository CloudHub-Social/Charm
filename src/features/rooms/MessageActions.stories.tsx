import type { Meta, StoryObj } from "@storybook/react-vite";
import { MessageActions } from "./MessageActions";

const meta = {
  title: "Rooms/MessageActions",
  component: MessageActions,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta<typeof MessageActions>;

export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => {};

export const OthersMessageWithoutRedact: Story = {
  args: {
    accountId: "@storybook:example.org",
    isOwn: false,
    canRedact: false,
    onReply: noop,
    onReact: noop,
    onEdit: noop,
    onDelete: noop,
    onCopy: noop,
    onCopyLink: noop,
  },
};

export const OwnMessage: Story = {
  args: {
    accountId: "@storybook:example.org",
    isOwn: true,
    canRedact: true,
    onReply: noop,
    onReact: noop,
    onEdit: noop,
    onDelete: noop,
    onCopy: noop,
    onCopyLink: noop,
  },
};

export const OthersMessageModeratorCanRedact: Story = {
  args: {
    accountId: "@storybook:example.org",
    isOwn: false,
    canRedact: true,
    onReply: noop,
    onReact: noop,
    onEdit: noop,
    onDelete: noop,
    onCopy: noop,
    onCopyLink: noop,
  },
};
