import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MediaContent } from "@/lib/matrix";
import { MediaMessage } from "./MediaMessage";

/**
 * Storybook has no real Tauri backend, so `useMediaSource`'s `resolveMedia`
 * IPC call has nothing to resolve against. Rather than mocking the module
 * (not supported the same way vitest's `vi.mock` is, in a Storybook static
 * build), each story pre-seeds a fresh `QueryClient`'s cache directly for the
 * exact `["media", roomId, eventId, thumbnail]` key `useMediaSource` reads —
 * same effect as a resolved IPC call, no network/Tauri dependency.
 */
function withSeededMedia(
  entries: { roomId: string; eventId: string; thumbnail: boolean; url: string }[],
) {
  const client = new QueryClient();
  for (const { roomId, eventId, thumbnail, url } of entries) {
    client.setQueryData(["media", roomId, eventId, thumbnail], url);
  }
  return client;
}

// Small inline placeholder images so stories render without network access.
const PLACEHOLDER_IMAGE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="180"><rect width="280" height="180" fill="%236b5ce7"/><text x="50%" y="50%" fill="white" font-size="20" text-anchor="middle" dy=".3em">image</text></svg>'.replaceAll(
      "%",
      "#",
    ),
  );

const ROOM_ID = "!story:localhost";

const meta = {
  title: "Rooms/MediaMessage",
  component: MediaMessage,
  tags: ["autodocs"],
} satisfies Meta<typeof MediaMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Image: Story = {
  args: {
    content: { type: "File", filename: "", mime: null, size: null },
    roomId: "",
    eventId: "",
    body: "",
  },
  render: () => {
    const content: MediaContent = {
      type: "Image",
      mime: "image/png",
      size: 245_000,
      width: 800,
      height: 600,
      has_thumbnail: true,
      blurhash: null,
    };
    const client = withSeededMedia([
      { roomId: ROOM_ID, eventId: "$story-image", thumbnail: true, url: PLACEHOLDER_IMAGE },
      { roomId: ROOM_ID, eventId: "$story-image", thumbnail: false, url: PLACEHOLDER_IMAGE },
    ]);
    return (
      <QueryClientProvider client={client}>
        <MediaMessage content={content} roomId={ROOM_ID} eventId="$story-image" body="cat.png" />
      </QueryClientProvider>
    );
  },
};

export const Video: Story = {
  args: {
    content: { type: "File", filename: "", mime: null, size: null },
    roomId: "",
    eventId: "",
    body: "",
  },
  render: () => {
    const content: MediaContent = {
      type: "Video",
      mime: "video/mp4",
      size: 5_400_000,
      width: 1920,
      height: 1080,
      duration_ms: 12_000,
      has_thumbnail: true,
    };
    const client = withSeededMedia([
      { roomId: ROOM_ID, eventId: "$story-video", thumbnail: true, url: PLACEHOLDER_IMAGE },
    ]);
    return (
      <QueryClientProvider client={client}>
        <MediaMessage content={content} roomId={ROOM_ID} eventId="$story-video" body="clip.mp4" />
      </QueryClientProvider>
    );
  },
};

export const Audio: Story = {
  args: {
    content: { type: "File", filename: "", mime: null, size: null },
    roomId: "",
    eventId: "",
    body: "",
  },
  render: () => {
    const content: MediaContent = {
      type: "Audio",
      mime: "audio/ogg",
      size: 89_000,
      duration_ms: 8_000,
    };
    const client = new QueryClient();
    return (
      <QueryClientProvider client={client}>
        <MediaMessage
          content={content}
          roomId={ROOM_ID}
          eventId="$story-audio"
          body="voice-memo.ogg"
        />
      </QueryClientProvider>
    );
  },
};

export const FileAttachment: Story = {
  args: {
    content: { type: "File", filename: "", mime: null, size: null },
    roomId: "",
    eventId: "",
    body: "",
  },
  render: () => {
    const content: MediaContent = {
      type: "File",
      filename: "quarterly-report.pdf",
      mime: "application/pdf",
      size: 1_240_000,
    };
    const client = new QueryClient();
    return (
      <QueryClientProvider client={client}>
        <MediaMessage
          content={content}
          roomId={ROOM_ID}
          eventId="$story-file"
          body="quarterly-report.pdf"
        />
      </QueryClientProvider>
    );
  },
};
