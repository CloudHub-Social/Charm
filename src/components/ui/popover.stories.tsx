import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./popover";
import { Button } from "./button";
import { Input } from "./input";
import { Label } from "./label";

const meta = {
  title: "UI/Popover",
  component: Popover,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Popover>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="flex min-h-64 items-center justify-center">
      <Popover defaultOpen>
        <PopoverTrigger asChild>
          <Button variant="outline">Open</Button>
        </PopoverTrigger>
        <PopoverContent aria-label="Notifications">
          <PopoverHeader>
            <PopoverTitle>Notifications</PopoverTitle>
            <PopoverDescription>Choose how this room notifies you.</PopoverDescription>
          </PopoverHeader>
        </PopoverContent>
      </Popover>
    </div>
  ),
};

// Popover carrying a small form — a common inline-edit pattern.
export const WithForm: Story = {
  render: () => (
    <div className="flex min-h-64 items-center justify-center">
      <Popover defaultOpen>
        <PopoverTrigger asChild>
          <Button variant="outline">Set nickname</Button>
        </PopoverTrigger>
        <PopoverContent aria-label="Room nickname">
          <div className="flex flex-col gap-3">
            <PopoverHeader>
              <PopoverTitle>Room nickname</PopoverTitle>
              <PopoverDescription>Only shown to you.</PopoverDescription>
            </PopoverHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="nickname">Nickname</Label>
              <Input id="nickname" placeholder="Design crew" />
            </div>
            <Button size="sm">Save</Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  ),
};
