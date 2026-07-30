import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TimelineItemSummary } from "@/lib/matrix";
import { makeMessageSummary } from "./testFixtures";
import { bucketTimelineNotices, TimelineNoticeList } from "./TimelineNotices";

const joined = (id: string, label: string): TimelineItemSummary => ({
  kind: "membership",
  event_id: `$${id}`,
  sender: `@${id}:example.org`,
  timestamp_ms: 1,
  target_user_id: `@${id}:example.org`,
  target_display_name: label,
  change: { type: "joined" },
  reason: null,
});

describe("TimelineNotices", () => {
  it("buckets notices before the next message and leaves tail notices trailing", () => {
    const items: TimelineItemSummary[] = [
      joined("alice", "Alice"),
      {
        kind: "message",
        message: makeMessageSummary({
          event_id: "$message",
          sender: "@alice:example.org",
          body: "hello",
        }),
      },
      {
        kind: "state",
        event_id: "$topic",
        sender: "@alice:example.org",
        timestamp_ms: 2,
        state_key: "",
        change: { type: "topic", old_value: null, new_value: "Planning" },
      },
    ];

    const buckets = bucketTimelineNotices(items, false, false);
    expect(buckets.beforeMessage.get("$message")).toHaveLength(1);
    expect(buckets.trailing).toHaveLength(1);
  });

  it("filters membership and hidden events independently", () => {
    const hidden: TimelineItemSummary = {
      kind: "state",
      event_id: "$hidden",
      sender: "@alice:example.org",
      timestamp_ms: 2,
      state_key: "",
      change: { type: "hidden", event_type: "com.example.custom" },
    };
    expect(bucketTimelineNotices([joined("alice", "Alice"), hidden], true, false).trailing).toEqual(
      [],
    );
    expect(
      bucketTimelineNotices([joined("alice", "Alice"), hidden], false, true).trailing,
    ).toHaveLength(2);
  });

  it("collapses consecutive matching membership changes and expands them", () => {
    render(
      <TimelineNoticeList
        notices={[
          joined("alice", "Alice") as never,
          joined("bob", "Bob") as never,
          joined("carol", "Carol") as never,
        ]}
      />,
    );

    const summary = screen.getByRole("button", {
      name: "Alice (@alice:example.org), Bob (@bob:example.org) and 1 others joined",
    });
    fireEvent.click(summary);
    const lines = screen.getByTestId("timeline-notices").querySelectorAll("p");
    expect([...lines].map((line) => line.textContent)).toEqual([
      "Alice (@alice:example.org) joined",
      "Bob (@bob:example.org) joined",
      "Carol (@carol:example.org) joined",
    ]);
  });

  it("renders moderated membership reasons and room state notices", () => {
    render(
      <TimelineNoticeList
        notices={[
          {
            kind: "membership",
            event_id: "$kick",
            sender: "@mod:example.org",
            timestamp_ms: 1,
            target_user_id: "@alice:example.org",
            target_display_name: "Alice",
            change: { type: "kicked" },
            reason: "spam",
          },
          {
            kind: "state",
            event_id: "$name",
            sender: "@mod:example.org",
            timestamp_ms: 2,
            state_key: "",
            change: { type: "name", old_value: "Old", new_value: "New" },
          },
        ]}
      />,
    );
    const lines = screen.getByTestId("timeline-notices").querySelectorAll("p");
    expect([...lines].map((line) => line.textContent)).toEqual([
      "Alice (@alice:example.org) was kicked by @mod:example.org: spam",
      "@mod:example.org changed the room name to New",
    ]);
  });
});
