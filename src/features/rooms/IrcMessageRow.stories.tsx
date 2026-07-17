import type { Meta, StoryObj } from "@storybook/react-vite";
import { IrcMessageRow } from "./IrcMessageRow";
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
  canPin: false,
  isPinned: false,
  readers: [],
  senderNameByUserId: new Map(),
  isNew: false,
  getActionsHandle: () => undefined,
  registerActionsRef: () => {},
  onReply: () => {},
  onReact: () => {},
  onEdit: () => {},
  onDelete: () => {},
  onPin: () => {},
  onUnpin: () => {},
  onCopy: () => {},
  onCopyLink: () => {},
  onResend: () => {},
  onDiscard: () => {},
  onJumpToMessage: () => {},
  isPending: false,
  isError: false,
  disableRelationActions: false,
  isUndecrypted: false,
  rowKey: "$1",
};

const meta = {
  title: "Rooms/IrcMessageRow",
  component: IrcMessageRow,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: baseArgs,
} satisfies Meta<typeof IrcMessageRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Other: Story = {};

export const Own: Story = {
  args: { own: true, canRedact: true },
};

export const RepeatedNick: Story = {
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

export const Reply: Story = {
  args: {
    message: makeMessageSummary({
      event_id: "$2",
      sender: "@bob:localhost",
      sender_display_name: "Bob",
      body: "Yeah, looks good!",
      in_reply_to: {
        event_id: "$1",
        sender: "@alice:localhost",
        sender_display_name: "Alice",
        preview: "Did you see the deploy?",
      },
    }),
  },
};

export const Pending: Story = {
  args: { own: true, isPending: true, disableRelationActions: true },
};

export const Error: Story = {
  args: { own: true, isError: true },
};

export const RichContent: Story = {
  args: {
    message: makeMessageSummary({
      event_id: "$rich",
      sender: "@bob:localhost",
      sender_display_name: "Bob",
      body: "Spoiler, code, table, Alice, math and emoji",
      formatted_body:
        '<p><span data-mx-spoiler="Movie ending">The butler did it</span></p><pre><code class="language-js">const charm = true;</code></pre><table><tr><th>Feature</th><th>Status</th></tr><tr><td>Rich HTML</td><td>Ready</td></tr></table><p><a data-mx-pill href="https://matrix.to/#/%40alice%3Alocalhost">Alice</a> @room <span data-mx-maths="x^2">x squared</span></p>',
    }),
  },
};
