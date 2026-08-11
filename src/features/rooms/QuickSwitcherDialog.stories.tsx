import type { Meta, StoryObj } from "@storybook/react-vite";
import { createRef } from "react";
import { QuickSwitcherDialog } from "./QuickSwitcherDialog";
import { makeRoomSummary } from "./testFixtures";

const meta = {
  title: "Rooms/QuickSwitcherDialog",
  component: QuickSwitcherDialog,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta<typeof QuickSwitcherDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    currentUserId: "@evie:example.org",
    onSelectRoom: () => {},
    returnFocusRef: createRef<HTMLElement>(),
    rooms: [
      makeRoomSummary({ room_id: "!work:example.org", name: "Work", is_space: true }),
      makeRoomSummary({
        room_id: "!design:example.org",
        name: "Design Studio",
        parent_space_ids: ["!work:example.org"],
      }),
      makeRoomSummary({
        room_id: "!alice:example.org",
        name: "Alice",
        is_direct: true,
        dm_peer_user_id: "@alice:example.org",
      }),
    ],
  },
};
