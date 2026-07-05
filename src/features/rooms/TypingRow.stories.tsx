import type { Meta, StoryObj } from "@storybook/react-vite";

/**
 * `ChatShell` doesn't factor the typing row into its own component (it's a
 * couple of inline lines above the composer), so this story just reproduces
 * the exact markup/pluralization Spec 05 specifies, for visual reference —
 * one other user, two, and three-or-more.
 */
function TypingRow({ text }: { text: string }) {
  return <output className="block px-4 pb-1 text-sm text-muted-foreground">{text}</output>;
}

const meta = {
  title: "Rooms/TypingRow",
  component: TypingRow,
} satisfies Meta<typeof TypingRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OneOtherUser: Story = {
  args: { text: "Alice is typing…" },
};

export const TwoOtherUsers: Story = {
  args: { text: "Alice and Bob are typing…" },
};

export const ThreeOrMoreOtherUsers: Story = {
  args: { text: "Alice, Bob, and 1 other are typing…" },
};
