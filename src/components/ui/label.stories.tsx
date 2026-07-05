import type { Meta, StoryObj } from "@storybook/react-vite";
import { Label } from "./label";
import { Input } from "./input";

const meta = {
  title: "UI/Label",
  component: Label,
  tags: ["autodocs"],
  args: { children: "Homeserver" },
} satisfies Meta<typeof Label>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <div className="flex w-72 flex-col gap-2">
      <Label htmlFor="homeserver" {...args} />
      <Input id="homeserver" placeholder="matrix.org" />
    </div>
  ),
};

// The label dims and blocks pointer events when its associated control is
// disabled (the `peer-disabled:` utilities keying off the sibling input).
export const Disabled: Story = {
  render: (args) => (
    <div className="flex w-72 flex-col gap-2">
      <Input id="homeserver-disabled" className="peer" placeholder="matrix.org" disabled />
      <Label htmlFor="homeserver-disabled" {...args}>
        Homeserver (disabled)
      </Label>
    </div>
  ),
};
