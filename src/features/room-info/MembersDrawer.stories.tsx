import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient } from "@tanstack/react-query";
import { AppProviders } from "@/providers";
import { MembersDrawer } from "./MembersDrawer";
import { roomDetailsQueryKey } from "./useRoomDetails";
import { roomMembersQueryKey } from "./useRoomMembers";
import type { RoomDetails, RoomMemberSummary } from "@/lib/matrix";

const ROOM_ID = "!story:localhost";

const DETAILS: RoomDetails = {
  room_id: ROOM_ID,
  name: "Design Team",
  topic: "All things design system",
  avatar_url: null,
  is_encrypted: true,
  join_rule: "invite",
  history_visibility: "shared",
  member_count: 3,
  my_power_level: 100,
  power_levels: {
    invite: 0,
    kick: 50,
    ban: 50,
    redact: 50,
    events_default: 0,
    state_default: 50,
    users_default: 0,
  },
  can: {
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
    set_pinned_events: true,
    set_space_child: true,
  },
  canonical_alias: null,
  alt_aliases: [],
  pinned_event_ids: [],
};

const MEMBERS: RoomMemberSummary[] = [
  {
    user_id: "@evie:localhost",
    display_name: "Evie",
    avatar_url: null,
    power_level: 100,
    membership: "join",
  },
  {
    user_id: "@alice:example.org",
    display_name: "Alice",
    avatar_url: null,
    power_level: 50,
    membership: "join",
  },
  {
    user_id: "@mallory:example.org",
    display_name: "Mallory",
    avatar_url: null,
    power_level: 0,
    membership: "ban",
  },
];

function seededQueryClient() {
  const client = new QueryClient();
  client.setQueryData(roomDetailsQueryKey(ROOM_ID), DETAILS);
  client.setQueryData(roomMembersQueryKey(ROOM_ID), MEMBERS);
  return client;
}

const meta = {
  title: "RoomInfo/MembersDrawer",
  component: MembersDrawer,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <AppProviders client={seededQueryClient()}>
        <div className="flex h-screen justify-end">
          <Story />
        </div>
      </AppProviders>
    ),
  ],
} satisfies Meta<typeof MembersDrawer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { roomId: ROOM_ID, currentUserId: "@evie:localhost", onClose: () => {} },
};
