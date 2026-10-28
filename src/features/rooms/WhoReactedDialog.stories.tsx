import type { Meta, StoryObj } from "@storybook/react-vite";
import { WhoReactedDialog } from "./WhoReactedDialog";

const meta = {
  title: "Rooms/WhoReactedDialog",
  component: WhoReactedDialog,
  tags: ["autodocs"],
  args: {
    open: true,
    reactionKey: "👍",
    details: [],
    onOpenChange: () => {},
  },
} satisfies Meta<typeof WhoReactedDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LongIdentities: Story = {
  args: {
    details: Array.from({ length: 20 }, (_, index) => ({
      sender: `@synthetic-reactor-${index}-${"long".repeat(24)}:example.org`,
      origin_server_ts: index,
    })),
  },
};

export const Loading: Story = { args: { loading: true } };
export const Retry: Story = { args: { error: true, onRetry: () => {} } };
