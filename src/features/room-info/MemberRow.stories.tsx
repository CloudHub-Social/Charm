import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient } from "@tanstack/react-query";
import { AppProviders } from "@/providers";
import { MemberRow } from "./MemberRow";
import type { RoomMemberSummary, RoomPermissions } from "@/lib/matrix";

const ADMIN_PERMISSIONS: RoomPermissions = {
  set_name: true,
  set_topic: true,
  set_avatar: true,
  set_join_rules: true,
  set_history_visibility: true,
  set_encryption: true,
  set_power_levels: true,
  invite: true,
  kick: true,
  ban: true,
};

const READ_ONLY_PERMISSIONS: RoomPermissions = {
  set_name: false,
  set_topic: false,
  set_avatar: false,
  set_join_rules: false,
  set_history_visibility: false,
  set_encryption: false,
  set_power_levels: false,
  invite: false,
  kick: false,
  ban: false,
};

const MEMBER: RoomMemberSummary = {
  user_id: "@alice:example.org",
  display_name: "Alice",
  avatar_url: null,
  power_level: 50,
  membership: "join",
};

const BANNED_MEMBER: RoomMemberSummary = {
  ...MEMBER,
  user_id: "@mallory:example.org",
  display_name: "Mallory",
  power_level: 0,
  membership: "ban",
};

const meta = {
  title: "RoomInfo/MemberRow",
  component: MemberRow,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <AppProviders client={new QueryClient()}>
        <div className="w-80 rounded-md border border-border bg-card">
          <Story />
        </div>
      </AppProviders>
    ),
  ],
} satisfies Meta<typeof MemberRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Admin: Story = {
  args: { roomId: "!story:localhost", member: MEMBER, can: ADMIN_PERMISSIONS, myPowerLevel: 100 },
};

export const ReadOnly: Story = {
  args: {
    roomId: "!story:localhost",
    member: MEMBER,
    can: READ_ONLY_PERMISSIONS,
    myPowerLevel: 0,
  },
};

export const Banned: Story = {
  args: {
    roomId: "!story:localhost",
    member: BANNED_MEMBER,
    can: ADMIN_PERMISSIONS,
    myPowerLevel: 100,
  },
};
