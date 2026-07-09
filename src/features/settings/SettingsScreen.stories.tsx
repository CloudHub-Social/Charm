import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, Provider as JotaiProvider } from "jotai";
import { useMemo } from "react";
import type { ReactNode } from "react";
import type { CrossSigningStatusSummary, DeviceSummary, ProfileSummary } from "@/lib/matrix";
import { DEFAULT_OBSERVABILITY_SETTINGS } from "@/observability/settings";
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
 * Opens directly on `section` with an isolated Jotai store per story so
 * snapshot order cannot leak the previously selected settings section.
 */
function SettingsStoryStore({
  section,
  children,
}: {
  section: SettingsSection;
  children: ReactNode;
}) {
  const store = useMemo(() => {
    const next = createStore();
    next.set(settingsOpenAtom, section);
    return next;
  }, [section]);
  return <JotaiProvider store={store}>{children}</JotaiProvider>;
}

/** Same seeded-`QueryClient` approach as `MediaMessage.stories.tsx` — every panel's data pre-populated so switching tabs never shows a loading state. */
function withSeededData({
  observability = DEFAULT_OBSERVABILITY_SETTINGS,
}: {
  observability?: typeof DEFAULT_OBSERVABILITY_SETTINGS;
} = {}) {
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
  client.setQueryData(["settings", "3pids"], []);
  client.setQueryData(["settings", "ignored-users"], []);
  client.setQueryData(["settings", "autostart"], false);
  client.setQueryData(["settings", "notification-permission"], true);
  client.setQueryData(["settings", "observability"], observability);
  return client;
}

const meta = {
  title: "Settings/SettingsScreen",
  component: SettingsScreen,
  tags: ["autodocs"],
} satisfies Meta<typeof SettingsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

async function waitForStoryText(canvasElement: HTMLElement, text: string) {
  const root = canvasElement.ownerDocument.body;
  await new Promise<void>((resolve, reject) => {
    let attempt = 0;
    const timer = window.setInterval(() => {
      attempt += 1;
      if (root.textContent?.includes(text)) {
        window.clearInterval(timer);
        resolve();
      } else if (attempt >= 50) {
        window.clearInterval(timer);
        reject(new Error(`Timed out waiting for story text: ${text}`));
      }
    }, 20);
  });
}

export const AccountSection: Story = {
  args: { onLoggedOut: () => {} },
  render: (args) => {
    const client = withSeededData();
    return (
      <QueryClientProvider client={client}>
        <SettingsStoryStore section="account">
          <SettingsScreen {...args} />
        </SettingsStoryStore>
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
        <SettingsStoryStore section="devices">
          <SettingsScreen {...args} />
        </SettingsStoryStore>
      </QueryClientProvider>
    );
  },
  play: async ({ canvasElement }) => {
    await waitForStoryText(canvasElement, "Charm on macOS");
  },
};

export const AboutSection: Story = {
  args: { onLoggedOut: () => {} },
  render: (args) => {
    const client = withSeededData();
    return (
      <QueryClientProvider client={client}>
        <SettingsStoryStore section="about">
          <SettingsScreen {...args} />
        </SettingsStoryStore>
      </QueryClientProvider>
    );
  },
};

export const KeyboardShortcutsSection: Story = {
  args: { onLoggedOut: () => {} },
  render: (args) => {
    const client = withSeededData();
    return (
      <QueryClientProvider client={client}>
        <SettingsStoryStore section="keyboard-shortcuts">
          <SettingsScreen {...args} />
        </SettingsStoryStore>
      </QueryClientProvider>
    );
  },
};

export const ObservabilitySectionDefaultOff: Story = {
  args: { onLoggedOut: () => {} },
  render: (args) => {
    const client = withSeededData();
    return (
      <QueryClientProvider client={client}>
        <SettingsStoryStore section="observability">
          <SettingsScreen {...args} />
        </SettingsStoryStore>
      </QueryClientProvider>
    );
  },
};

export const ObservabilitySectionOptedIn: Story = {
  args: { onLoggedOut: () => {} },
  render: (args) => {
    const client = withSeededData({
      observability: {
        ...DEFAULT_OBSERVABILITY_SETTINGS,
        sentryEnabled: true,
        replayEnabled: true,
        anonymousUserId: "story-observability-user",
      },
    });
    return (
      <QueryClientProvider client={client}>
        <SettingsStoryStore section="observability">
          <SettingsScreen {...args} />
        </SettingsStoryStore>
      </QueryClientProvider>
    );
  },
};
