import type { Meta, StoryObj } from "@storybook/react-vite";
import { FormattingToolbar } from "./FormattingToolbar";

const meta = {
  title: "Rooms/FormattingToolbar",
  component: FormattingToolbar,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta<typeof FormattingToolbar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No editor mounted yet — every button renders disabled. */
export const NoEditor: Story = {
  args: { editor: null },
};
