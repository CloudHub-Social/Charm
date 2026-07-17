import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { DiscordMessageRow } from "./DiscordMessageRow";
import { makeMessageSummary } from "./testFixtures";
import type { MessageRowLayoutProps } from "./messageRowShared";

// LinkPreviewForMessage (Spec 29) reads the room-details query cache via
// `useQuery`, which needs a QueryClientProvider ancestor even when its own
// query is disabled — wrap every render the same way the real app does.
function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function baseProps(overrides: Partial<MessageRowLayoutProps> = {}): MessageRowLayoutProps {
  return {
    message: makeMessageSummary({ event_id: "$1", sender: "@bob:localhost", body: "hello" }),
    roomId: "!room:localhost",
    own: false,
    sameSenderAsPrev: false,
    sameSenderAsNext: false,
    canRedact: false,
    readers: [],
    senderNameByUserId: new Map(),
    isNew: false,
    getActionsHandle: () => undefined,
    registerActionsRef: vi.fn(),
    onReply: vi.fn(),
    onReact: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onCopy: vi.fn(),
    onCopyLink: vi.fn(),
    onResend: vi.fn(),
    onDiscard: vi.fn(),
    onJumpToMessage: vi.fn(),
    isPending: false,
    isError: false,
    disableRelationActions: false,
    isUndecrypted: false,
    rowKey: "$1",
    ...overrides,
  };
}

describe("DiscordMessageRow", () => {
  it("never right-aligns or reverses own messages — always left-aligned", () => {
    const { container } = render(<DiscordMessageRow {...baseProps({ own: true })} />);
    expect(container.querySelector(".ml-auto")).not.toBeInTheDocument();
    expect(container.querySelector(".flex-row-reverse")).not.toBeInTheDocument();
  });

  it("never renders a bubble background class", () => {
    const { container } = render(<DiscordMessageRow {...baseProps({ own: true })} />);
    expect(container.querySelector(".bg-primary-solid")).not.toBeInTheDocument();
    expect(container.querySelector(".bg-secondary")).not.toBeInTheDocument();
  });

  it("shows the avatar and header for the current user's own first-in-run message", () => {
    const { container } = render(
      <DiscordMessageRow {...baseProps({ own: true, sameSenderAsPrev: false })} />,
    );
    expect(container.querySelector('[data-size="sm"]')).toBeInTheDocument();
  });

  it("shows the header (name + time) only on the first message of a run", () => {
    render(
      <DiscordMessageRow
        {...baseProps({
          sameSenderAsPrev: false,
          message: makeMessageSummary({
            event_id: "$1",
            sender: "@bob:localhost",
            sender_display_name: "Bob",
            body: "first",
          }),
        })}
      />,
    );
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("hides the header on a follow-up message in the same run", () => {
    const { container } = render(
      <DiscordMessageRow
        {...baseProps({
          sameSenderAsPrev: true,
          message: makeMessageSummary({
            event_id: "$2",
            sender: "@bob:localhost",
            sender_display_name: "Bob",
            body: "follow-up",
          }),
        })}
      />,
    );
    expect(screen.queryByText("Bob")).not.toBeInTheDocument();
    // No avatar column for a follow-up row — just the hover-reveal timestamp spacer.
    expect(container.querySelector('[data-size="sm"]')).not.toBeInTheDocument();
  });

  it("renders a redacted message as Message deleted with no bubble wrapper", () => {
    render(
      <DiscordMessageRow
        {...baseProps({
          message: makeMessageSummary({
            event_id: "$1",
            sender: "@bob:localhost",
            body: "",
            redacted: true,
          }),
        })}
      />,
    );
    expect(screen.getByText("Message deleted")).toBeInTheDocument();
  });

  it("shows pending/error state on the header line", () => {
    render(<DiscordMessageRow {...baseProps({ isPending: true })} />);
    expect(screen.getByText(/sending…/)).toBeInTheDocument();
  });

  it("shows the (edited) indicator on a follow-up message in a same-sender run", () => {
    // Regression test: the follow-up meta line only checked isPending/isError
    // and silently dropped the edited indicator for grouped messages.
    render(
      <DiscordMessageRow
        {...baseProps({
          sameSenderAsPrev: true,
          message: makeMessageSummary({
            event_id: "$2",
            sender: "@bob:localhost",
            body: "follow-up, edited",
            edited: true,
          }),
        })}
      />,
    );
    expect(screen.getByText("(edited)")).toBeInTheDocument();
  });

  it("shows pending/error/edited status for a message in the MIDDLE of a same-sender run", () => {
    // Regression test: the old `showMeta && !showHeader` guard required
    // sameSenderAsNext === false, so a message that's neither first nor
    // last in a run (both sameSenderAsPrev and sameSenderAsNext true)
    // never showed its status at all.
    render(
      <DiscordMessageRow
        {...baseProps({
          sameSenderAsPrev: true,
          sameSenderAsNext: true,
          isError: true,
        })}
      />,
    );
    expect(screen.getByText(/failed to send/)).toBeInTheDocument();
  });

  it("lets a long sender name truncate instead of pushing the timestamp off-row", () => {
    render(
      <DiscordMessageRow
        {...baseProps({
          message: makeMessageSummary({
            event_id: "$1",
            sender: "@bob:localhost",
            sender_display_name: "A Very Long Display Name That Should Not Overflow The Header",
            body: "hi",
          }),
        })}
      />,
    );
    const name = screen.getByText(/A Very Long Display Name/);
    expect(name).toHaveClass("truncate");
    expect(name).toHaveClass("min-w-0");
  });

  it("wraps a long plain-text body instead of letting it overflow the row", () => {
    render(<DiscordMessageRow {...baseProps()} />);
    const body = screen.getByText("hello");
    expect(body).toHaveClass("break-words");
    expect(body).toHaveClass("min-w-0");
  });

  it("plays the entrance animation for a new message", () => {
    const { container } = render(<DiscordMessageRow {...baseProps({ isNew: true })} />);
    expect(container.firstChild).toHaveClass("animate-in");
  });

  it("does not animate a message that isn't new", () => {
    const { container } = render(<DiscordMessageRow {...baseProps({ isNew: false })} />);
    expect(container.firstChild).not.toHaveClass("animate-in");
  });
});
