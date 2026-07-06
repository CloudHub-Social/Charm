import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProfileSummary } from "@/lib/matrix";
import { AccountPanel } from "./AccountPanel";

/**
 * Storybook has no real Tauri backend — same approach as
 * `MediaMessage.stories.tsx`: pre-seed a fresh `QueryClient`'s cache for the
 * exact key `useProfile` reads, rather than module-mocking `@/lib/matrix`.
 */
function withSeededProfile(profile: ProfileSummary) {
  const client = new QueryClient();
  client.setQueryData(["profile"], profile);
  return client;
}

const meta = {
  title: "Settings/AccountPanel",
  component: AccountPanel,
  tags: ["autodocs"],
} satisfies Meta<typeof AccountPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { onLoggedOut: () => {} },
  render: (args) => {
    const client = withSeededProfile({
      user_id: "@evie:cloudhub.social",
      display_name: "Evie",
      avatar_url: null,
    });
    return (
      <QueryClientProvider client={client}>
        <AccountPanel {...args} />
      </QueryClientProvider>
    );
  },
};

export const NoDisplayNameSet: Story = {
  args: { onLoggedOut: () => {} },
  render: (args) => {
    const client = withSeededProfile({
      user_id: "@evie:cloudhub.social",
      display_name: null,
      avatar_url: null,
    });
    return (
      <QueryClientProvider client={client}>
        <AccountPanel {...args} />
      </QueryClientProvider>
    );
  },
};
