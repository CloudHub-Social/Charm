import type { Meta, StoryObj } from "@storybook/react-vite";
import { Provider, createStore } from "jotai";
import { badgeAtom } from "@/features/shell/badgeAtom";
import { SpaceRail } from "./SpaceRail";
import { makeRoomSummary } from "./testFixtures";

const baseRooms = [
  makeRoomSummary({ room_id: "!space:localhost", name: "Team", is_space: true }),
  makeRoomSummary({
    room_id: "!child-space:localhost",
    name: "Product",
    is_space: true,
    parent_space_ids: ["!space:localhost"],
  }),
  makeRoomSummary({ room_id: "!solo:localhost", name: "Open Source", is_space: true }),
];

const unreadDms = [
  makeRoomSummary({
    room_id: "!alice:localhost",
    name: "Alice",
    is_direct: true,
    has_unread: true,
    unread_count: 2,
    last_activity_ts: 500,
  }),
  makeRoomSummary({
    room_id: "!beatrice:localhost",
    name: "Beatrice with a deliberately long display name",
    is_direct: true,
    has_unread: true,
    last_activity_ts: 400,
  }),
  makeRoomSummary({
    room_id: "!cam:localhost",
    name: "Cam",
    is_direct: true,
    has_unread: true,
    unread_count: 1,
    last_activity_ts: 300,
  }),
  makeRoomSummary({
    room_id: "!devon:localhost",
    name: "Devon",
    is_direct: true,
    has_unread: true,
    unread_count: 4,
    last_activity_ts: 200,
  }),
  makeRoomSummary({
    room_id: "!emery:localhost",
    name: "Emery",
    is_direct: true,
    has_unread: true,
    last_activity_ts: 100,
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
    rooms: [...baseRooms, ...unreadDms.slice(0, 1)],
    activeMode: "home",
    activeSpaceId: null,
    showAllRooms: false,
    currentUserId: "@storybook:localhost",
    onSelectHome: () => {},
    onSelectDms: () => {},
    onSelectRoom: () => {},
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

export const NoUnreadDirectMessages: Story = {
  args: { rooms: baseRooms },
};

export const ThreeUnreadDirectMessages: Story = {
  args: { rooms: [...baseRooms, ...unreadDms.slice(0, 3)] },
};

export const UnreadDirectMessageOverflow: Story = {
  args: {
    rooms: [...baseRooms, ...unreadDms],
    activeMode: "dms",
    activeRoomId: "!alice:localhost",
  },
};
