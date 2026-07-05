import type { Meta, StoryObj } from "@storybook/react-vite";
import { Input } from "./input";
import { Label } from "./label";

const meta = {
  title: "UI/Input",
  component: Input,
  tags: ["autodocs"],
  args: { placeholder: "matrix.org" },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true, defaultValue: "can't edit" } };
export const Invalid: Story = { args: { "aria-invalid": true, defaultValue: "bad value" } };

export const WithLabel: Story = {
  render: (args) => (
    <div className="flex w-72 flex-col gap-2">
      <Label htmlFor="homeserver">Homeserver</Label>
      <Input id="homeserver" {...args} />
    </div>
  ),
};
