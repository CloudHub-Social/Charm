import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient } from "@tanstack/react-query";
import { createStore } from "jotai";
import { AppProviders } from "@/providers";
import { RoomSettingsModal } from "./RoomSettingsModal";
import { roomSettingsAtom } from "./roomInfoAtoms";
import { roomDetailsQueryKey } from "./useRoomDetails";
import { roomMembersQueryKey } from "./useRoomMembers";
import type { RoomDetails, RoomMemberSummary } from "@/lib/matrix";

const ROOM_ID = "!story:localhost";

const ADMIN_DETAILS: RoomDetails = {
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

const READ_ONLY_DETAILS: RoomDetails = {
  ...ADMIN_DETAILS,
  my_power_level: 0,
  can: {
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
    set_pinned_events: false,
    set_space_child: false,
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

/** Seeds a fresh QueryClient's cache directly so the modal renders real data — Storybook has no Tauri host, so the underlying `get_room_details`/`get_room_member_list` invokes reject; seeded data survives a failed background refetch (TanStack Query keeps last-known-good `data` on refetch error). */
function seededQueryClient(details: RoomDetails) {
  const client = new QueryClient();
  client.setQueryData(roomDetailsQueryKey(ROOM_ID), details);
  client.setQueryData(roomMembersQueryKey(ROOM_ID), MEMBERS);
  return client;
}

function seededStore(section: "general" | "members" | "permissions") {
  const store = createStore();
  store.set(roomSettingsAtom, { roomId: ROOM_ID, section });
  return store;
}

const meta = {
  title: "RoomInfo/RoomSettingsModal",
  component: RoomSettingsModal,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof RoomSettingsModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const General: Story = {
  args: { currentUserId: "@evie:localhost" },
  decorators: [
    (Story) => (
      <AppProviders client={seededQueryClient(ADMIN_DETAILS)} store={seededStore("general")}>
        <Story />
      </AppProviders>
    ),
  ],
};

export const Members: Story = {
  args: { currentUserId: "@evie:localhost" },
  decorators: [
    (Story) => (
      <AppProviders client={seededQueryClient(ADMIN_DETAILS)} store={seededStore("members")}>
        <Story />
      </AppProviders>
    ),
  ],
};

export const Permissions: Story = {
  args: { currentUserId: "@evie:localhost" },
  decorators: [
    (Story) => (
      <AppProviders client={seededQueryClient(ADMIN_DETAILS)} store={seededStore("permissions")}>
        <Story />
      </AppProviders>
    ),
  ],
};

export const ReadOnlyMember: Story = {
  args: { currentUserId: "@evie:localhost" },
  decorators: [
    (Story) => (
      <AppProviders client={seededQueryClient(READ_ONLY_DETAILS)} store={seededStore("general")}>
        <Story />
      </AppProviders>
    ),
  ],
};
