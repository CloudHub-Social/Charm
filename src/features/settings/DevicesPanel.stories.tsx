import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CrossSigningStatusSummary, DeviceSummary } from "@/lib/matrix";
import { DevicesPanel } from "./DevicesPanel";

const DEVICES: DeviceSummary[] = [
  {
    device_id: "CURRENTDEVICE",
    display_name: "Charm on macOS",
    last_seen_ip: "203.0.113.4",
    last_seen_ts: Date.parse("2026-07-05T10:00:00Z"),
    is_current: true,
    is_verified: true,
  },
  {
    device_id: "PHONEDEVICE",
    display_name: "Charm on iOS",
    last_seen_ip: "203.0.113.9",
    last_seen_ts: Date.parse("2026-07-04T21:00:00Z"),
    is_current: false,
    is_verified: true,
  },
  {
    device_id: "UNKNOWNDEVICE",
    display_name: null,
    last_seen_ip: null,
    last_seen_ts: null,
    is_current: false,
    is_verified: false,
  },
];

/** Same seeded-`QueryClient` approach as `MediaMessage.stories.tsx` — no real Tauri backend in Storybook. */
function withSeededDevices(devices: DeviceSummary[], status: CrossSigningStatusSummary) {
  const client = new QueryClient();
  client.setQueryData(["devices"], devices);
  client.setQueryData(["crossSigningStatus"], status);
  client.setQueryData(["crossSigningResetUrl"], null);
  return client;
}

const meta = {
  title: "Settings/DevicesPanel",
  component: DevicesPanel,
  tags: ["autodocs"],
} satisfies Meta<typeof DevicesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Bootstrapped: Story = {
  render: () => {
    const client = withSeededDevices(DEVICES, {
      has_master_key: true,
      has_self_signing_key: true,
      has_user_signing_key: true,
    });
    return (
      <QueryClientProvider client={client}>
        <DevicesPanel />
      </QueryClientProvider>
    );
  },
};

export const NotSetUp: Story = {
  render: () => {
    const client = withSeededDevices(DEVICES, {
      has_master_key: false,
      has_self_signing_key: false,
      has_user_signing_key: false,
    });
    return (
      <QueryClientProvider client={client}>
        <DevicesPanel />
      </QueryClientProvider>
    );
  },
};
