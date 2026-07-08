import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingsCard, SettingTile } from "./SettingsCard";

const meta = {
  title: "Settings/SettingsCard",
  component: SettingsCard,
  tags: ["autodocs"],
} satisfies Meta<typeof SettingsCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithHeading: Story = {
  args: { children: null },
  render: () => (
    <div className="max-w-md">
      <SettingsCard heading="Security">
        <SettingTile title="Password" control={<Button size="sm">Change password</Button>} />
        <SettingTile title="Sign out" control={<Button size="sm">Log out</Button>} />
      </SettingsCard>
    </div>
  ),
};

export const WithDescription: Story = {
  args: { children: null },
  render: () => (
    <div className="max-w-md">
      <SettingsCard>
        <SettingTile
          title="Theme"
          description="Changes apply immediately and are remembered on this device."
          control={
            <Button variant="outline" size="sm">
              Dark
            </Button>
          }
        />
      </SettingsCard>
    </div>
  ),
};

export const WithSwitch: Story = {
  args: { children: null },
  render: () => (
    <div className="max-w-md">
      <SettingsCard heading="Notifications">
        <SettingTile
          title="Do not disturb"
          description="Mute notification delivery until this setting is turned off."
          control={<Switch aria-label="Mute all rooms" defaultChecked />}
        />
        <SettingTile
          title="Sound"
          description="Play a sound when a notification arrives."
          control={<Switch aria-label="Play a sound for notifications" defaultChecked />}
        />
      </SettingsCard>
    </div>
  ),
};

export const CustomRowContent: Story = {
  args: { children: null },
  render: () => (
    <div className="max-w-md">
      <SettingsCard heading="Blocked Users">
        <SettingTile>
          <p className="text-sm text-muted-foreground">No blocked users yet.</p>
        </SettingTile>
      </SettingsCard>
    </div>
  ),
};
