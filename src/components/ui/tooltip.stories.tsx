import type { Meta, StoryObj } from "@storybook/react-vite";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";
import { Button } from "./button";

const meta = {
  title: "UI/Tooltip",
  component: Tooltip,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="flex min-h-40 items-center justify-center">
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon-sm" aria-label="Add reaction">
              +
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add reaction</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  ),
};

// Tooltip anchored below its trigger via the `side` prop.
export const Below: Story = {
  render: () => (
    <div className="flex min-h-40 items-center justify-center">
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger asChild>
            <Button variant="outline">Homeserver</Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">cloudhub.social</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  ),
};
