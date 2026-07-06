import type { Meta, StoryObj } from "@storybook/react-vite";
import { RoomListItem } from "./RoomListItem";
import { makeRoomSummary } from "./testFixtures";

const meta = {
  title: "Rooms/RoomListItem",
  component: RoomListItem,
  tags: ["autodocs"],
} satisfies Meta<typeof RoomListItem>;

export default meta;
type Story = StoryObj<typeof meta>;

// A `ResolvedAvatarImage` story (non-null `avatar_path`) isn't included:
// `resolveAvatar` calls the real `@tauri-apps/api/core#convertFileSrc`
// unconditionally when given a path, which throws with no Tauri backend
// behind it — unlike `useMediaSource` (see `MediaMessage.stories.tsx`), this
// is a synchronous helper with no TanStack Query cache layer to pre-seed
// around it. The "with an avatar image" appearance is covered instead by
// `avatar.stories.tsx`'s `SenderIdentity`/`WithImage` stories, which render
// `AvatarImage` directly with a data URI rather than through this resolver.
export const InitialsFallback: Story = {
  args: {
    room: makeRoomSummary({ name: "general", avatar_path: null }),
    active: false,
    onSelect: () => {},
  },
};

export const ActiveRoom: Story = {
  args: {
    room: makeRoomSummary({ name: "general" }),
    active: true,
    onSelect: () => {},
  },
};

export const UnreadWithCount: Story = {
  args: {
    room: makeRoomSummary({ name: "general", has_unread: true, unread_count: 5 }),
    active: false,
    onSelect: () => {},
  },
};
