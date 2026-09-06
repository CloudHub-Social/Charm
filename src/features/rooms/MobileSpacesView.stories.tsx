import type { Meta, StoryObj } from "@storybook/react-vite";
import { MobileSpacesView } from "./MobileSpacesView";
import { makeRoomSummary } from "./testFixtures";

const rooms = [
  makeRoomSummary({ room_id: "!friends:localhost", name: "Friends", is_space: true }),
  makeRoomSummary({
    room_id: "!games:localhost",
    name: "Games",
    is_space: true,
    parent_space_ids: ["!friends:localhost"],
  }),
  makeRoomSummary({ room_id: "!work:localhost", name: "Creative Work", is_space: true }),
  makeRoomSummary({
    room_id: "!lounge:localhost",
    name: "Charm Lounge",
    parent_space_ids: ["!friends:localhost"],
    has_unread: true,
  }),
  makeRoomSummary({
    room_id: "!ada:localhost",
    name: "Ada",
    is_direct: true,
    has_unread: true,
  }),
];

const meta = {
  title: "Rooms/MobileSpacesView",
  component: MobileSpacesView,
  parameters: { viewport: { defaultViewport: "mobile2" } },
  decorators: [
    (Story) => (
      <div data-ux-refresh="true" className="h-[844px] w-[390px] bg-background">
        <Story />
      </div>
    ),
  ],
  args: {
    rooms,
    activeMode: "space",
    activeSpaceId: "!friends:localhost",
    showAllRooms: false,
    onSelectHome: () => {},
    onSelectDms: () => {},
    onSelectSpace: () => {},
    onCreateJoin: () => {},
  },
} satisfies Meta<typeof MobileSpacesView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {};

export const Empty: Story = {
  args: { rooms: [], activeMode: "home", activeSpaceId: null },
};
