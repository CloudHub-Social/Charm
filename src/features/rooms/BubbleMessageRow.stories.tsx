import type { Meta, StoryObj } from "@storybook/react-vite";
import { BubbleMessageRow } from "./BubbleMessageRow";
import { makeMessageSummary } from "./testFixtures";
import type { MessageRowLayoutProps } from "./messageRowShared";

const baseArgs: MessageRowLayoutProps = {
  message: makeMessageSummary({
    event_id: "$1",
    sender: "@bob:localhost",
    sender_display_name: "Bob",
    body: "Hey, did you see the latest deploy?",
  }),
  roomId: "!room:localhost",
  own: false,
  sameSenderAsPrev: false,
  sameSenderAsNext: false,
  canRedact: false,
  readers: [],
  isNew: false,
  getActionsHandle: () => undefined,
  registerActionsRef: () => {},
  onReply: () => {},
  onReact: () => {},
  onEdit: () => {},
  onDelete: () => {},
  onCopy: () => {},
  isPending: false,
  isError: false,
  disableRelationActions: false,
  isUndecrypted: false,
  rowKey: "$1",
};

const meta = {
  title: "Rooms/BubbleMessageRow",
  component: BubbleMessageRow,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: baseArgs,
} satisfies Meta<typeof BubbleMessageRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Other: Story = {};

export const Own: Story = {
  args: { own: true, canRedact: true },
};

export const GroupedFollowUp: Story = {
  args: { sameSenderAsPrev: true, sameSenderAsNext: true },
};

export const Redacted: Story = {
  args: {
    message: makeMessageSummary({
      event_id: "$1",
      sender: "@bob:localhost",
      body: "",
      redacted: true,
    }),
  },
};

export const Pending: Story = {
  args: { own: true, isPending: true, disableRelationActions: true },
};

export const Error: Story = {
  args: { own: true, isError: true },
};
