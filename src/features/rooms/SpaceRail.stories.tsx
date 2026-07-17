import type { Meta, StoryObj } from "@storybook/react-vite";
import { Provider, createStore } from "jotai";
import { badgeAtom } from "@/features/shell/badgeAtom";
import { SpaceRail } from "./SpaceRail";
import { makeRoomSummary } from "./testFixtures";

const rooms = [
  makeRoomSummary({ room_id: "!space:localhost", name: "Team", is_space: true }),
  makeRoomSummary({
    room_id: "!child-space:localhost",
    name: "Product",
    is_space: true,
    parent_space_ids: ["!space:localhost"],
  }),
  makeRoomSummary({ room_id: "!solo:localhost", name: "Open Source", is_space: true }),
  makeRoomSummary({
    room_id: "!dm:localhost",
    name: "Alice",
    is_direct: true,
    has_unread: true,
    unread_count: 2,
  }),
];

const store = createStore();
store.set(badgeAtom, {
  total_unread: 3,
  total_highlight: 0,
  spaces: {
    "!space:localhost": { total_unread: 1, total_highlight: 4 },
    "!child-space:localhost": { total_unread: 1, total_highlight: 0 },
  },
});

const meta = {
  title: "Rooms/SpaceRail",
  component: SpaceRail,
  decorators: [
    (Story) => (
      <Provider store={store}>
        <div className="h-[520px] bg-background">
          <Story />
        </div>
      </Provider>
    ),
  ],
  args: {
    rooms,
    activeMode: "home",
    activeSpaceId: null,
    showAllRooms: false,
    currentUserId: "@storybook:localhost",
    onSelectHome: () => {},
    onSelectDms: () => {},
    onSelectSpace: () => {},
    onCreateJoin: () => {},
  },
} satisfies Meta<typeof SpaceRail>;

export default meta;
type Story = StoryObj<typeof meta>;

export const HomeSelected: Story = {};

export const DirectMessagesSelected: Story = {
  args: {
    activeMode: "dms",
  },
};

export const SpaceSelectedWithFolder: Story = {
  args: {
    activeMode: "space",
    activeSpaceId: "!space:localhost",
  },
};
