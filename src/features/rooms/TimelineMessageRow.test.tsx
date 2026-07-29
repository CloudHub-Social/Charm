import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeMessageSummary } from "./testFixtures";
import { TimelineMessageRow } from "./TimelineMessageRow";
import type { MessageActionController } from "./useMessageActionController";

const rowSpy = vi.hoisted(() => vi.fn());
vi.mock("./MessageRow", () => ({
  messageRowKey: (message: { transaction_id: string | null; event_id: string }) =>
    message.transaction_id ?? message.event_id,
  MessageRow: (props: Record<string, unknown>) => {
    rowSpy(props);
    return <span>message row</span>;
  },
}));

const first = makeMessageSummary({
  event_id: "$first",
  sender: "@alice:example.org",
  body: "first",
  timestamp_ms: new Date("2026-07-28T23:59:00Z").getTime(),
});
const second = makeMessageSummary({
  event_id: "$second",
  sender: "@alice:example.org",
  body: "second",
  timestamp_ms: new Date("2026-07-29T00:01:00Z").getTime(),
});

function controller(): MessageActionController {
  return {
    visibleDialogTarget: null,
    closeDialog: vi.fn(),
    confirmDialog: vi.fn(async () => true),
    getActionsHandle: vi.fn(),
    registerActionsRef: vi.fn(),
    rowActions: vi.fn(() => ({
      onReply: vi.fn(),
      onReact: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onCopy: vi.fn(),
      onResend: vi.fn(),
      onDiscard: vi.fn(),
      onCopyLink: vi.fn(),
      onPin: vi.fn(),
      onUnpin: vi.fn(),
      onForward: undefined,
      onViewSource: undefined,
      onReport: undefined,
      onViewEditHistory: undefined,
      onBookmark: undefined,
      onUnbookmark: undefined,
      isBookmarked: false,
    })),
  };
}

describe("TimelineMessageRow", () => {
  it("owns dividers and breaks sender grouping across them", () => {
    render(
      <TimelineMessageRow
        index={1}
        messages={[first, second]}
        message={second}
        roomId="!room:example.org"
        currentUserId="@me:example.org"
        unreadStartIndex={1}
        canRedact={true}
        canPin={true}
        isPinned={false}
        readers={[]}
        senderNameByUserId={new Map()}
        newMessageKeys={new Set(["$second"])}
        controller={controller()}
        onJumpToMessage={vi.fn()}
        onUserPillClick={vi.fn()}
      />,
    );

    expect(screen.getByText("New messages")).toBeInTheDocument();
    expect(rowSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sameSenderAsPrev: false,
        own: false,
        canRedact: true,
        isNew: true,
      }),
    );
  });

  it("keeps own messages immediately redactable and excludes them from entrance animation", () => {
    const own = { ...second, sender: "@me:example.org" };
    render(
      <TimelineMessageRow
        index={0}
        messages={[own]}
        message={own}
        roomId="!room:example.org"
        currentUserId="@me:example.org"
        unreadStartIndex={-1}
        canRedact={false}
        canPin={false}
        isPinned={false}
        readers={[]}
        senderNameByUserId={new Map()}
        newMessageKeys={new Set(["$second"])}
        controller={controller()}
        onJumpToMessage={vi.fn()}
        onUserPillClick={vi.fn()}
      />,
    );

    expect(rowSpy).toHaveBeenCalledWith(
      expect.objectContaining({ own: true, canRedact: true, isNew: false }),
    );
  });
});
