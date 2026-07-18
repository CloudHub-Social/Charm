import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient } from "@tanstack/react-query";
import { AppProviders } from "@/providers";
import { PowerLevelThresholdsEditor } from "./PowerLevelEditor";
import type { RoomDetails } from "@/lib/matrix";

const BASE_DETAILS: RoomDetails = {
  room_id: "!story:localhost",
  name: "Story Room",
  topic: null,
  avatar_url: null,
  is_encrypted: false,
  join_rule: "invite",
  history_visibility: "shared",
  member_count: 3,
  my_power_level: 100,
  power_levels: {
    invite: 0,
    kick: 50,
    ban: 50,
    redact: 50,
    events_default: 0,
    state_default: 50,
    users_default: 0,
  },
  can: {
    set_name: true,
    set_topic: true,
    set_avatar: true,
    set_join_rules: true,
    set_history_visibility: true,
    set_encryption: true,
    set_power_levels: true,
    invite: true,
    kick: true,
    ban: true,
    set_canonical_alias: true,
    set_pinned_events: true,
  },
  canonical_alias: null,
  alt_aliases: [],
  pinned_event_ids: [],
};

const meta = {
  title: "RoomInfo/PowerLevelThresholdsEditor",
  component: PowerLevelThresholdsEditor,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <AppProviders client={new QueryClient()}>
        <div className="w-80 rounded-md border border-border bg-card">
          <Story />
        </div>
      </AppProviders>
    ),
  ],
} satisfies Meta<typeof PowerLevelThresholdsEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Admin: Story = {
  args: { details: BASE_DETAILS },
};

export const ReadOnly: Story = {
  args: {
    details: {
      ...BASE_DETAILS,
      my_power_level: 0,
      can: { ...BASE_DETAILS.can, set_power_levels: false },
    },
  },
};
