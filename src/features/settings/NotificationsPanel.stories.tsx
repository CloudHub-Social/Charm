import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NotificationSettingsSummary, RoomSummary } from "@/lib/matrix";
import { NotificationsPanel } from "./NotificationsPanel";

const ROOMS: RoomSummary[] = [
  {
    room_id: "!general:localhost",
    name: "General",
    unread_count: 0,
    unread_messages: 0,
    is_marked_unread: false,
    is_muted: false,
    notification_mode: "all_messages",
    is_favourite: false,
    is_low_priority: false,
    manual_order: null,
    is_space: false,
    parent_space_ids: [],
    is_direct: false,
    has_unread: false,
  },
  {
    room_id: "!announcements:localhost",
    name: "Announcements",
    unread_count: 0,
    unread_messages: 0,
    is_marked_unread: false,
    is_muted: true,
    notification_mode: "mute",
    is_favourite: false,
    is_low_priority: false,
    manual_order: null,
    is_space: false,
    parent_space_ids: [],
    is_direct: false,
    has_unread: false,
  },
  {
    room_id: "!watercooler:localhost",
    name: "Watercooler",
    unread_count: 0,
    unread_messages: 0,
    is_marked_unread: false,
    is_muted: false,
    notification_mode: "mentions_and_keywords_only",
    is_favourite: false,
    is_low_priority: false,
    manual_order: null,
    is_space: false,
    parent_space_ids: [],
    is_direct: false,
    has_unread: false,
  },
];

const SETTINGS: NotificationSettingsSummary = {
  default_mode: "all_messages",
  keywords: ["urgent", "on-call"],
  global_mute: false,
  sound_enabled: true,
};

/** Same seeded-`QueryClient` approach as `MediaMessage.stories.tsx` — no real Tauri backend in Storybook. */
function withSeededSettings(settings: NotificationSettingsSummary, rooms: RoomSummary[]) {
  const client = new QueryClient();
  client.setQueryData(["notificationSettings"], settings);
  client.setQueryData(["rooms", "notifications-panel"], rooms);
  return client;
}

const meta = {
  title: "Settings/NotificationsPanel",
  component: NotificationsPanel,
  tags: ["autodocs"],
} satisfies Meta<typeof NotificationsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const client = withSeededSettings(SETTINGS, ROOMS);
    return (
      <QueryClientProvider client={client}>
        <NotificationsPanel />
      </QueryClientProvider>
    );
  },
};

export const DoNotDisturbActive: Story = {
  render: () => {
    const client = withSeededSettings({ ...SETTINGS, global_mute: true }, ROOMS);
    return (
      <QueryClientProvider client={client}>
        <NotificationsPanel />
      </QueryClientProvider>
    );
  },
};
