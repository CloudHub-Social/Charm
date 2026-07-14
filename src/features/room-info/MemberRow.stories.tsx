import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient } from "@tanstack/react-query";
import { AppProviders } from "@/providers";
import { TooltipProvider } from "@/components/ui/tooltip";
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
  set_canonical_alias: true,
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
  set_canonical_alias: false,
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
        <TooltipProvider>
          <div className="w-80 rounded-md border border-border bg-card">
            <Story />
          </div>
        </TooltipProvider>
      </AppProviders>
    ),
  ],
} satisfies Meta<typeof MemberRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Admin: Story = {
  args: {
    roomId: "!story:localhost",
    member: MEMBER,
    can: ADMIN_PERMISSIONS,
    myPowerLevel: 100,
    currentUserId: "@evie:localhost",
  },
};

export const ReadOnly: Story = {
  args: {
    roomId: "!story:localhost",
    member: MEMBER,
    can: READ_ONLY_PERMISSIONS,
    myPowerLevel: 0,
    currentUserId: "@evie:localhost",
  },
};

export const Banned: Story = {
  args: {
    roomId: "!story:localhost",
    member: BANNED_MEMBER,
    can: ADMIN_PERMISSIONS,
    myPowerLevel: 100,
    currentUserId: "@evie:localhost",
  },
};

/**
 * The acting user has `can.kick`/`can.ban`/`can.set_power_levels`, but this
 * particular member outranks them — the menu still opens (unlike the
 * `ReadOnly` story, which has no permissions at all and hides it entirely),
 * with every item disabled behind a tooltip once opened. Open the "⋯" menu
 * in Storybook's canvas to check the `GatedItem`/`TooltipProvider` path.
 */
export const OutrankedPeer: Story = {
  args: {
    roomId: "!story:localhost",
    member: { ...MEMBER, power_level: 100 },
    can: ADMIN_PERMISSIONS,
    myPowerLevel: 100,
    currentUserId: "@evie:localhost",
  },
};
