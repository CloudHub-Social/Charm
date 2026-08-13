import type { Meta, StoryObj } from "@storybook/react-vite";
import { createStore, Provider } from "jotai";
import { presenceAtomFamily } from "@/features/presence/presenceAtoms";
import type { GroupDmAvatarMember } from "@/lib/matrix";
import { GroupDmAvatar } from "./GroupDmAvatar";

const MEMBERS: GroupDmAvatarMember[] = [
  { user_id: "@alice:cloudhub.social", display_name: "Alice", avatar_url: null },
  { user_id: "@bob:cloudhub.social", display_name: "Bob", avatar_url: null },
  { user_id: "@carol:cloudhub.social", display_name: "Carol", avatar_url: null },
];

function SeededGroupAvatar({ showPresenceRing }: { showPresenceRing: boolean }) {
  const store = createStore();
  store.set(presenceAtomFamily(MEMBERS[0].user_id), {
    user_id: MEMBERS[0].user_id,
    presence: "dnd",
    status_msg: "Heads down",
    last_active_ago_ms: null,
  });
  return (
    <Provider store={store}>
      <div className="flex items-center gap-3 rounded-md bg-background p-6 text-foreground">
        <GroupDmAvatar members={MEMBERS} showPresenceRing={showPresenceRing} />
        <span>Alice, Bob, Carol</span>
      </div>
    </Provider>
  );
}

const meta = {
  title: "Rooms/GroupDmAvatar",
  component: GroupDmAvatar,
  tags: ["autodocs"],
  args: { members: MEMBERS, showPresenceRing: true },
} satisfies Meta<typeof GroupDmAvatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PresenceRing: Story = {
  render: () => <SeededGroupAvatar showPresenceRing />,
};

export const PresenceDot: Story = {
  render: () => <SeededGroupAvatar showPresenceRing={false} />,
};
