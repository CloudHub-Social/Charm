import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DiscordMessageRow } from "./DiscordMessageRow";
import { makeMessageSummary } from "./testFixtures";
import type { MessageRowLayoutProps } from "./messageRowShared";

function baseProps(overrides: Partial<MessageRowLayoutProps> = {}): MessageRowLayoutProps {
  return {
    message: makeMessageSummary({ event_id: "$1", sender: "@bob:localhost", body: "hello" }),
    roomId: "!room:localhost",
    own: false,
    sameSenderAsPrev: false,
    sameSenderAsNext: false,
    canRedact: false,
    readers: [],
    getActionsHandle: () => undefined,
    registerActionsRef: vi.fn(),
    onReply: vi.fn(),
    onReact: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onCopy: vi.fn(),
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
});
