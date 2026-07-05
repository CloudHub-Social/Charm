import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Lightbox } from "./Lightbox";

const PLACEHOLDER_IMAGE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="%236b5ce7"/><text x="50%" y="50%" fill="white" font-size="32" text-anchor="middle" dy=".3em">full-res image</text></svg>'.replaceAll(
      "%",
      "#",
    ),
  );

const ROOM_ID = "!story:localhost";
const EVENT_ID = "$story-lightbox";

function withSeededMedia() {
  const client = new QueryClient();
  client.setQueryData(["media", ROOM_ID, EVENT_ID, false], PLACEHOLDER_IMAGE);
  return client;
}

const meta = {
  title: "Rooms/Lightbox",
  component: Lightbox,
  tags: ["autodocs"],
  parameters: {
    // Renders with the dialog already open, same pattern as UI/Dialog.
    layout: "fullscreen",
  },
} satisfies Meta<typeof Lightbox>;

export default meta;
type Story = StoryObj<typeof meta>;

function LightboxDemo() {
  const [open, setOpen] = useState(true);
  return (
    <QueryClientProvider client={withSeededMedia()}>
      <div className="p-6">
        <Button onClick={() => setOpen(true)}>Reopen lightbox</Button>
      </div>
      <Lightbox
        open={open}
        onOpenChange={setOpen}
        roomId={ROOM_ID}
        eventId={EVENT_ID}
        kind="image"
        alt="A sample image in the lightbox"
      />
    </QueryClientProvider>
  );
}

export const Default: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    roomId: ROOM_ID,
    eventId: EVENT_ID,
    kind: "image",
    alt: "A sample image in the lightbox",
  },
  render: () => <LightboxDemo />,
};
