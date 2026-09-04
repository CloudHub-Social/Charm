import { describe, expect, it } from "vitest";
import { formatDisplayDate, formatDisplayTime } from "./dateTime";
import { formatDateDividerLabel } from "@/features/rooms/timelineDividers";

const timestamp = Date.UTC(2026, 8, 3, 13, 5);
const context = { locale: "en-US", timeZone: "UTC" };

describe("appearance date and clock formats", () => {
  it("preserves locale clock defaults", () => {
    expect(formatDisplayTime(timestamp, "locale", context)).toBe(
      new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "UTC",
      }).format(new Date(timestamp)),
    );
  });

  it("supports explicit 12-hour and 24-hour clocks independently of locale defaults", () => {
    expect(formatDisplayTime(timestamp, "12h", context)).toBe("1:05 PM");
    expect(formatDisplayTime(timestamp, "24h", context)).toBe("13:05");
    expect(formatDisplayTime(Date.UTC(2026, 8, 3), "24h", context)).toBe("00:00");
  });

  it("formats each numeric date order", () => {
    expect(formatDisplayDate(timestamp, "day-first", context)).toBe("03/09/2026");
    expect(formatDisplayDate(timestamp, "month-first", context)).toBe("09/03/2026");
    expect(formatDisplayDate(timestamp, "year-first", context)).toBe("2026-09-03");
    expect(formatDisplayDate(timestamp, "locale", context)).toBe("September 3, 2026");
  });

  it("keeps numeric dates Gregorian and applies the display time zone", () => {
    expect(
      formatDisplayDate(Date.UTC(2026, 8, 3, 1), "year-first", {
        locale: "th-TH",
        timeZone: "America/Toronto",
      }),
    ).toBe("2026-09-02");
  });

  it("preserves relative day labels while honoring the historical-date preset", () => {
    const now = new Date(2026, 8, 5, 12);
    expect(formatDateDividerLabel(now.getTime(), now, "en-US", "year-first")).toBe("Today");
    expect(
      formatDateDividerLabel(new Date(2026, 8, 4, 12).getTime(), now, "en-US", "year-first"),
    ).toBe("Yesterday");
    expect(
      formatDateDividerLabel(new Date(2026, 8, 3, 12).getTime(), now, "en-US", "year-first"),
    ).toBe("2026-09-03");
  });
});
