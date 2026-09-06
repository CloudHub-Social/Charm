import type { Meta, StoryObj } from "@storybook/react-vite";
import { makeRoomSummary } from "@/features/rooms/testFixtures";
import { ActivityView } from "./ActivityView";

const meta = {
  title: "Activity/ActivityView",
  component: ActivityView,
  parameters: { layout: "fullscreen" },
  args: {
    onSelectRoom: () => {},
    rooms: [
      makeRoomSummary({
        room_id: "!invite:localhost",
        name: "Charm contributors",
        membership: "invite",
        inviter_display_name: "Ada",
      }),
      makeRoomSummary({
        room_id: "!design:localhost",
        name: "Design studio",
        unread_count: 3,
        has_unread: true,
        last_message_preview: {
          sender_id: "@sable:localhost",
          sender_display_name: "Sable",
          text: "The revised navigation is ready for review.",
        },
      }),
    ],
  },
} satisfies Meta<typeof ActivityView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithAttention: Story = {};
export const AllCaughtUp: Story = { args: { rooms: [] } };
