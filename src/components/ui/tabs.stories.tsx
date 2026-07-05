import type { Meta, StoryObj } from "@storybook/react-vite";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

const meta = {
  title: "UI/Tabs",
  component: Tabs,
  tags: ["autodocs"],
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

const panels = (
  <>
    <TabsContent value="chats" className="pt-3 text-sm text-muted-foreground">
      Recent conversations across your rooms.
    </TabsContent>
    <TabsContent value="people" className="pt-3 text-sm text-muted-foreground">
      Direct messages and contacts.
    </TabsContent>
    <TabsContent value="settings" className="pt-3 text-sm text-muted-foreground">
      Account and appearance preferences.
    </TabsContent>
  </>
);

export const Default: Story = {
  render: () => (
    <Tabs defaultValue="chats" className="w-80">
      <TabsList>
        <TabsTrigger value="chats">Chats</TabsTrigger>
        <TabsTrigger value="people">People</TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
      </TabsList>
      {panels}
    </Tabs>
  ),
};

// The `line` list variant swaps the filled pill for an underline indicator.
export const Line: Story = {
  render: () => (
    <Tabs defaultValue="chats" className="w-80">
      <TabsList variant="line">
        <TabsTrigger value="chats">Chats</TabsTrigger>
        <TabsTrigger value="people">People</TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
      </TabsList>
      {panels}
    </Tabs>
  ),
};

export const Vertical: Story = {
  render: () => (
    <Tabs defaultValue="chats" orientation="vertical" className="w-96">
      <TabsList>
        <TabsTrigger value="chats">Chats</TabsTrigger>
        <TabsTrigger value="people">People</TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
      </TabsList>
      {panels}
    </Tabs>
  ),
};

export const Disabled: Story = {
  render: () => (
    <Tabs defaultValue="chats" className="w-80">
      <TabsList>
        <TabsTrigger value="chats">Chats</TabsTrigger>
        <TabsTrigger value="people" disabled>
          People
        </TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
      </TabsList>
      {panels}
    </Tabs>
  ),
};
