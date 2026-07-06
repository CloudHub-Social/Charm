import type { Meta, StoryObj } from "@storybook/react-vite";
import { PresenceDot } from "@/features/presence/PresenceDot";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from "./avatar";

const meta = {
  title: "UI/Avatar",
  component: Avatar,
  tags: ["autodocs"],
  argTypes: {
    size: { control: "inline-radio", options: ["sm", "default", "lg"] },
  },
} satisfies Meta<typeof Avatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Fallback: Story = {
  args: { size: "default" },
  render: (args) => (
    <Avatar {...args}>
      <AvatarFallback>EV</AvatarFallback>
    </Avatar>
  ),
};

export const WithImage: Story = {
  args: { size: "lg" },
  render: (args) => (
    <Avatar {...args}>
      <AvatarImage
        src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect width='80' height='80' fill='%236366f1'/%3E%3C/svg%3E"
        alt="Placeholder avatar"
      />
      <AvatarFallback>EV</AvatarFallback>
    </Avatar>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Avatar size="sm">
        <AvatarFallback>S</AvatarFallback>
      </Avatar>
      <Avatar size="default">
        <AvatarFallback>M</AvatarFallback>
      </Avatar>
      <Avatar size="lg">
        <AvatarFallback>L</AvatarFallback>
      </Avatar>
    </div>
  ),
};

export const Group: Story = {
  render: () => (
    <AvatarGroup>
      <Avatar>
        <AvatarFallback>AB</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback>CD</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback>EF</AvatarFallback>
      </Avatar>
      <AvatarGroupCount>+3</AvatarGroupCount>
    </AvatarGroup>
  ),
};

/**
 * The read-receipt avatar stack Spec 05's `ChatShell` renders under a
 * message: one small avatar per user whose most recent read receipt points
 * at that message, capped and overflowing into a "+N" count — same
 * `AvatarGroup`/`AvatarGroupCount` primitives as {@link Group}, just at the
 * `sm` size `ChatShell` actually uses.
 */
export const ReadReceiptStack: Story = {
  render: () => (
    <AvatarGroup className="justify-end">
      <Avatar size="sm">
        <AvatarFallback style={{ background: "var(--color-danger)" }} className="text-white">
          AL
        </AvatarFallback>
      </Avatar>
      <Avatar size="sm">
        <AvatarFallback style={{ background: "var(--color-success)" }} className="text-white">
          BO
        </AvatarFallback>
      </Avatar>
      <Avatar size="sm">
        <AvatarFallback style={{ background: "var(--color-warning)" }} className="text-white">
          CA
        </AvatarFallback>
      </Avatar>
      <AvatarGroupCount>+2</AvatarGroupCount>
    </AvatarGroup>
  ),
};

/**
 * Spec 01's timeline sender identity: an avatar (image when the sender has
 * one resolved, initials fallback otherwise) paired with their display name
 * — the `ChatShell` message-row shape, with/without a resolved avatar image.
 */
export const SenderIdentity: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Avatar size="sm">
          <AvatarImage
            src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='%23f59e0b'/%3E%3C/svg%3E"
            alt=""
          />
          <AvatarFallback style={{ background: "var(--color-warning)" }} className="text-white">
            AA
          </AvatarFallback>
        </Avatar>
        <span className="text-sm font-semibold text-secondary-foreground">Alice Anderson</span>
      </div>
      <div className="flex items-center gap-2">
        <Avatar size="sm">
          <AvatarFallback style={{ background: "var(--color-accent)" }} className="text-white">
            BO
          </AvatarFallback>
        </Avatar>
        {/* No display name resolved yet — falls back to the raw MXID. */}
        <span className="text-sm font-semibold text-secondary-foreground">@bob:example.org</span>
      </div>
    </div>
  ),
};

/** The DM header/room-list avatar, with the online presence dot Spec 01 adds. */
export const WithPresenceDot: Story = {
  args: { size: "lg" },
  render: (args) => (
    <Avatar {...args}>
      <AvatarFallback style={{ background: "var(--color-success)" }} className="text-white">
        EV
      </AvatarFallback>
      <PresenceDot presence="online" />
    </Avatar>
  ),
};
