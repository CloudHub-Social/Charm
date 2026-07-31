import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fn } from "storybook/test";
import { MessagePillProfileDialog } from "./MessagePillProfileDialog";

const accountId = "@me:example.org";
const userId = "@alice:example.org";
const roomId = "!current:example.org";

const client = new QueryClient();
client.setQueryData(["user-profile", accountId, userId, roomId], {
  user_id: userId,
  display_name: "Alice Anderson",
  avatar_url: null,
  avatar_path: null,
  room_display_name: "Alice",
  room_avatar_url: null,
  room_avatar_path: null,
  presence: {
    user_id: userId,
    presence: "online",
    status_msg: "Working on Charm",
    last_active_ago_ms: null,
  },
});
client.setQueryData(
  ["mutual-rooms", accountId, userId],
  [
    {
      room_id: "!design:example.org",
      name: "Design",
      avatar_url: null,
      avatar_path: null,
      is_direct: false,
      is_space: false,
    },
    {
      room_id: "!charm:example.org",
      name: "Charm",
      avatar_url: null,
      avatar_path: null,
      is_direct: false,
      is_space: false,
    },
  ],
);

const meta = {
  title: "Rooms/User profile card",
  component: MessagePillProfileDialog,
  decorators: [
    (Story) => (
      <QueryClientProvider client={client}>
        <Story />
      </QueryClientProvider>
    ),
  ],
  args: {
    profile: { userId, label: "Alice" },
    accountId,
    roomId,
    detailed: true,
    refetchOnMount: false,
    onClose: fn(),
    onNavigateToRoom: fn(),
  },
} satisfies Meta<typeof MessagePillProfileDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Detailed: Story = {};
