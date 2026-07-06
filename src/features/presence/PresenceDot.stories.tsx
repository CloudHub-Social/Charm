import type { Meta, StoryObj } from "@storybook/react-vite";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { PresenceDot } from "./PresenceDot";

const meta = {
  title: "Rooms/PresenceDot",
  component: PresenceDot,
  tags: ["autodocs"],
  argTypes: {
    presence: { control: "inline-radio", options: ["online", "unavailable", "offline"] },
  },
  render: (args) => (
    <Avatar>
      <AvatarFallback>EV</AvatarFallback>
      <PresenceDot {...args} />
    </Avatar>
  ),
} satisfies Meta<typeof PresenceDot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Online: Story = {
  args: { presence: "online" },
};

export const Away: Story = {
  args: { presence: "unavailable" },
};

export const Offline: Story = {
  args: { presence: "offline" },
};

/** Presence isn't known yet (not fetched, or the lookup failed) — renders nothing rather than a misleading default dot. */
export const Unknown: Story = {
  args: { presence: null },
};
