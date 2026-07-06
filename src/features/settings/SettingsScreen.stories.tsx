import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useHydrateAtoms } from "jotai/utils";
import type { ReactNode } from "react";
import type { CrossSigningStatusSummary, DeviceSummary, ProfileSummary } from "@/lib/matrix";
import { settingsOpenAtom, type SettingsSection } from "./settingsAtoms";
import { SettingsScreen } from "./SettingsScreen";

const PROFILE: ProfileSummary = {
  user_id: "@evie:cloudhub.social",
  display_name: "Evie",
  avatar_url: null,
  uses_oauth: false,
};

const DEVICES: DeviceSummary[] = [
  {
    device_id: "CURRENTDEVICE",
    display_name: "Charm on macOS",
    last_seen_ip: "203.0.113.4",
    last_seen_ts: Date.parse("2026-07-05T10:00:00Z"),
    is_current: true,
    is_verified: true,
  },
];

const CROSS_SIGNING_STATUS: CrossSigningStatusSummary = {
  has_master_key: true,
  has_self_signing_key: true,
  has_user_signing_key: true,
};

/**
 * Opens directly on `section` — `jotai`'s `Provider` (v2) has no
 * `initialValues` prop of its own, so `useHydrateAtoms` (its documented
 * replacement) seeds `settingsOpenAtom` before the tree below reads it.
 */
function HydrateSettingsOpen({
  section,
  children,
}: {
  section: SettingsSection;
  children: ReactNode;
}) {
  useHydrateAtoms([[settingsOpenAtom, section]]);
  return children;
}

/** Same seeded-`QueryClient` approach as `MediaMessage.stories.tsx` — every panel's data pre-populated so switching tabs never shows a loading state. */
function withSeededData() {
  const client = new QueryClient();
  client.setQueryData(["profile"], PROFILE);
  client.setQueryData(["devices"], DEVICES);
  client.setQueryData(["crossSigningStatus"], CROSS_SIGNING_STATUS);
  client.setQueryData(["crossSigningResetUrl"], null);
  client.setQueryData(["notificationSettings"], {
    default_mode: "all_messages",
    keywords: [],
    global_mute: false,
    sound_enabled: true,
  });
  client.setQueryData(["rooms", "notifications-panel"], []);
  return client;
}

const meta = {
  title: "Settings/SettingsScreen",
  component: SettingsScreen,
  tags: ["autodocs"],
} satisfies Meta<typeof SettingsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AccountSection: Story = {
  args: { onLoggedOut: () => {} },
  render: (args) => {
    const client = withSeededData();
    return (
      <QueryClientProvider client={client}>
        <HydrateSettingsOpen section="account">
          <SettingsScreen {...args} />
        </HydrateSettingsOpen>
      </QueryClientProvider>
    );
  },
};

export const DevicesSection: Story = {
  args: { onLoggedOut: () => {} },
  render: (args) => {
    const client = withSeededData();
    return (
      <QueryClientProvider client={client}>
        <HydrateSettingsOpen section="devices">
          <SettingsScreen {...args} />
        </HydrateSettingsOpen>
      </QueryClientProvider>
    );
  },
};
