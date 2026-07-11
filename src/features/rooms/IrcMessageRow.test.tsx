import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IrcMessageRow } from "./IrcMessageRow";
import { makeMessageSummary } from "./testFixtures";
import type { MessageRowLayoutProps } from "./messageRowShared";

function baseProps(overrides: Partial<MessageRowLayoutProps> = {}): MessageRowLayoutProps {
  return {
    message: makeMessageSummary({
      event_id: "$1",
      sender: "@bob:localhost",
      sender_display_name: "Bob",
      body: "hello",
    }),
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

describe("IrcMessageRow", () => {
  it("renders [HH:MM] <nick> body on every line, ignoring sameSenderAsPrev/Next", () => {
    render(<IrcMessageRow {...baseProps({ sameSenderAsPrev: true, sameSenderAsNext: true })} />);
    expect(screen.getByText("<Bob>")).toBeInTheDocument();
    expect(screen.getByText(/\d+:\d+/)).toBeInTheDocument();
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("repeats the nick on consecutive same-sender messages instead of collapsing it", () => {
    const { rerender } = render(
      <IrcMessageRow {...baseProps({ sameSenderAsPrev: false, message: baseProps().message })} />,
    );
    expect(screen.getByText("<Bob>")).toBeInTheDocument();

    rerender(
      <IrcMessageRow
        {...baseProps({
          sameSenderAsPrev: true,
          message: makeMessageSummary({
            event_id: "$2",
            sender: "@bob:localhost",
            sender_display_name: "Bob",
            body: "second line",
          }),
        })}
      />,
    );
    expect(screen.getByText("<Bob>")).toBeInTheDocument();
  });

  it("never renders an avatar", () => {
    const { container } = render(<IrcMessageRow {...baseProps()} />);
    expect(container.querySelector('[data-size="sm"]')).not.toBeInTheDocument();
  });

  it("colors the nick the same way for own and other senders — no special-casing", () => {
    const { container: otherContainer } = render(<IrcMessageRow {...baseProps({ own: false })} />);
    const { container: ownContainer } = render(<IrcMessageRow {...baseProps({ own: true })} />);
    const otherNick = otherContainer.querySelector("span[style]");
    const ownNick = ownContainer.querySelector("span[style]");
    expect(otherNick?.getAttribute("style")).toBe(ownNick?.getAttribute("style"));
  });

  it("renders a redacted message with the * message deleted action-style prefix", () => {
    render(
      <IrcMessageRow
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
    expect(screen.getByText("* message deleted")).toBeInTheDocument();
  });

  it("hides edited/pending/error status suffixes for a redacted message", () => {
    // Regression test: an edited message that's later redacted must not
    // show "(edited)" next to "* message deleted" — matches Bubble/Discord,
    // which both gate their status suffixes on !message.redacted.
    render(
      <IrcMessageRow
        {...baseProps({
          isPending: true,
          isError: true,
          message: makeMessageSummary({
            event_id: "$1",
            sender: "@bob:localhost",
            body: "",
            redacted: true,
            edited: true,
          }),
        })}
      />,
    );
    expect(screen.getByText("* message deleted")).toBeInTheDocument();
    expect(screen.queryByText("(edited)")).not.toBeInTheDocument();
    expect(screen.queryByText("(sending…)")).not.toBeInTheDocument();
    expect(screen.queryByText("(failed to send)")).not.toBeInTheDocument();
  });

  it("compresses a reply into an inline (re: sender) prefix rather than a block", () => {
    render(
      <IrcMessageRow
        {...baseProps({
          message: makeMessageSummary({
            event_id: "$2",
            sender: "@bob:localhost",
            sender_display_name: "Bob",
            body: "reply text",
            in_reply_to: {
              event_id: "$1",
              sender: "@alice:localhost",
              sender_display_name: "Alice",
              preview: "original",
            },
          }),
        })}
      />,
    );
    expect(screen.getByText(/re:/)).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("still renders MessageActions and ReactionBar — density, not feature removal", () => {
    render(<IrcMessageRow {...baseProps({ canRedact: true })} />);
    expect(screen.getByRole("button", { name: /more/i })).toBeInTheDocument();
  });

  it("shows pending/error/edited suffixes inline", () => {
    render(<IrcMessageRow {...baseProps({ isPending: true })} />);
    expect(screen.getByText(/sending…/)).toBeInTheDocument();
  });

  it("truncates a long nick instead of letting it push the body off-row", () => {
    const { container } = render(
      <IrcMessageRow
        {...baseProps({
          message: makeMessageSummary({
            event_id: "$1",
            sender: "@bob:localhost",
            sender_display_name: "A Very Long Display Name That Should Not Overflow",
            body: "hi",
          }),
        })}
      />,
    );
    const nick = container.querySelector(".truncate");
    expect(nick).toBeInTheDocument();
    expect(nick).toHaveClass("shrink");
  });

  it("forces block-level formatted_body markup inline so it stays on one line", () => {
    // Uses a `[&_*]:inline` wildcard rather than naming each block tag, so
    // this stays correct against the sanitizer's full allowlist (headings,
    // tables, details/summary, hr, etc.) — not just the originally-cited
    // p/blockquote/list/div/pre subset.
    render(
      <IrcMessageRow
        {...baseProps({
          message: makeMessageSummary({
            event_id: "$1",
            sender: "@bob:localhost",
            body: "quoted text",
            formatted_body: "<blockquote>quoted text</blockquote><h1>a heading</h1>",
          }),
        })}
      />,
    );
    const blockquote = screen.getByText("quoted text").closest("blockquote");
    const heading = screen.getByText("a heading").closest("h1");
    expect(blockquote).toBeInTheDocument();
    expect(heading).toBeInTheDocument();
    expect(blockquote?.closest("span")).toHaveClass("[&_*]:inline");
  });
});
