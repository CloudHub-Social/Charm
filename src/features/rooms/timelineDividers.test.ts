import { describe, expect, it } from "vitest";
import {
  formatDateDividerLabel,
  isDateDividerBoundary,
  unreadDividerIndex,
} from "./timelineDividers";

// Constructed with the local-time `Date(year, month, day, ...)` form (not
// ISO/`Z` strings) throughout, matching `timelineDividers.ts`'s use of local
// getters (`getFullYear`/`getMonth`/`getDate`) — an ISO string's UTC instant
// can land on a different local calendar day depending on the runner's time
// zone, which would make these tests flaky.
describe("formatDateDividerLabel", () => {
  const now = new Date(2026, 6, 11, 12, 0, 0);

  it("labels same-day timestamps as Today", () => {
    expect(formatDateDividerLabel(new Date(2026, 6, 11, 1, 0, 0).getTime(), now)).toBe("Today");
  });

  it("labels the previous calendar day as Yesterday", () => {
    expect(formatDateDividerLabel(new Date(2026, 6, 10, 23, 0, 0).getTime(), now)).toBe(
      "Yesterday",
    );
  });

  it("falls back to a formatted date for older messages", () => {
    expect(formatDateDividerLabel(new Date(2026, 6, 1, 12, 0, 0).getTime(), now)).toBe("July 1");
  });

  it("includes the year for a date in a different year", () => {
    expect(formatDateDividerLabel(new Date(2025, 6, 1, 12, 0, 0).getTime(), now)).toBe(
      "July 1, 2025",
    );
  });
});

describe("isDateDividerBoundary", () => {
  it("is true for the first message", () => {
    expect(isDateDividerBoundary([{ timestamp_ms: 1000 }], 0)).toBe(true);
  });

  it("is true when the day changes from the previous message", () => {
    const messages = [
      { timestamp_ms: new Date(2026, 6, 10, 23, 0, 0).getTime() },
      { timestamp_ms: new Date(2026, 6, 11, 1, 0, 0).getTime() },
    ];
    expect(isDateDividerBoundary(messages, 1)).toBe(true);
  });

  it("is false for consecutive messages on the same day", () => {
    const messages = [
      { timestamp_ms: new Date(2026, 6, 11, 1, 0, 0).getTime() },
      { timestamp_ms: new Date(2026, 6, 11, 2, 0, 0).getTime() },
    ];
    expect(isDateDividerBoundary(messages, 1)).toBe(false);
  });
});

describe("unreadDividerIndex", () => {
  it("returns -1 when there's nothing unread", () => {
    expect(unreadDividerIndex(10, 0)).toBe(-1);
  });

  it("returns the start index of the last unreadCount messages", () => {
    expect(unreadDividerIndex(10, 3)).toBe(7);
  });

  it("clamps to 0 when unreadCount exceeds the message count", () => {
    expect(unreadDividerIndex(2, 5)).toBe(0);
  });
});
