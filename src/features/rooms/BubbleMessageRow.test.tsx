import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { BubbleMessageRow } from "./BubbleMessageRow";
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

describe("BubbleMessageRow", () => {
  it("right-aligns own messages and left-aligns others'", () => {
    const { container: ownContainer } = render(<BubbleMessageRow {...baseProps({ own: true })} />);
    expect(ownContainer.querySelector(".ml-auto.flex-row-reverse")).toBeInTheDocument();

    const { container: otherContainer } = render(
      <BubbleMessageRow {...baseProps({ own: false })} />,
    );
    expect(otherContainer.querySelector(".ml-auto.flex-row-reverse")).not.toBeInTheDocument();
  });

  it("uses the primary-solid bubble for own messages, secondary for others'", () => {
    const { container: ownContainer } = render(<BubbleMessageRow {...baseProps({ own: true })} />);
    expect(ownContainer.querySelector(".bg-primary-solid")).toBeInTheDocument();

    const { container: otherContainer } = render(
      <BubbleMessageRow {...baseProps({ own: false })} />,
    );
    expect(otherContainer.querySelector(".bg-secondary")).toBeInTheDocument();
  });

  it("shows the avatar only for others' first-in-run message, never for own", () => {
    const { container: firstInRun } = render(
      <BubbleMessageRow {...baseProps({ own: false, sameSenderAsPrev: false })} />,
    );
    expect(firstInRun.querySelector('[data-size="sm"]')).toBeInTheDocument();

    const { container: grouped } = render(
      <BubbleMessageRow {...baseProps({ own: false, sameSenderAsPrev: true })} />,
    );
    expect(grouped.querySelector('[data-size="sm"]')).not.toBeInTheDocument();

    const { container: ownFirst } = render(
      <BubbleMessageRow {...baseProps({ own: true, sameSenderAsPrev: false })} />,
    );
    expect(ownFirst.querySelector('[data-size="sm"]')).not.toBeInTheDocument();
  });

  it("shows the meta line (timestamp) only when it's the last message in the run", () => {
    render(<BubbleMessageRow {...baseProps({ sameSenderAsNext: false })} />);
    expect(screen.getByText(/\d+:\d+/)).toBeInTheDocument();
  });

  it("hides the meta line when a follow-up message in the same run comes next", () => {
    render(<BubbleMessageRow {...baseProps({ sameSenderAsNext: true })} />);
    expect(screen.queryByText(/\d+:\d+/)).not.toBeInTheDocument();
  });

  it("renders a redacted message as a Message deleted placeholder with no actions", () => {
    render(
      <BubbleMessageRow
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
    expect(screen.queryByRole("button", { name: /more/i })).not.toBeInTheDocument();
  });

  it("shows a sending suffix while pending and a failed suffix on error", () => {
    render(<BubbleMessageRow {...baseProps({ isPending: true })} />);
    expect(screen.getByText(/sending…/)).toBeInTheDocument();

    render(<BubbleMessageRow {...baseProps({ isError: true })} />);
    expect(screen.getByText(/failed to send/)).toBeInTheDocument();
  });

  it("renders plain body text when there is no formatted_body", () => {
    render(
      <BubbleMessageRow
        {...baseProps({
          message: makeMessageSummary({
            event_id: "$1",
            sender: "@bob:localhost",
            body: "plain text message",
          }),
        })}
      />,
    );
    expect(screen.getByText("plain text message")).toBeInTheDocument();
  });
});
