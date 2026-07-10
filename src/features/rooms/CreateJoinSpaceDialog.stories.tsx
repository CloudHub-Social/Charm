import type { Meta, StoryObj } from "@storybook/react-vite";
import { CreateJoinSpaceDialog } from "./CreateJoinSpaceDialog";

const meta = {
  title: "Rooms/CreateJoinSpaceDialog",
  component: CreateJoinSpaceDialog,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta<typeof CreateJoinSpaceDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    onSpaceCreated: () => {},
    onSpaceJoined: () => {},
  },
};
