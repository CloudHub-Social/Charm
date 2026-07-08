import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@/components/ui/button";
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
