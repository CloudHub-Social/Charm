export type ClockFormat = "locale" | "12h" | "24h";
export type DateFormat = "locale" | "day-first" | "month-first" | "year-first";

interface FormattingContext {
  locale?: string;
  timeZone?: string;
}

/** Explicit hour cycles avoid locales that render midnight as 24:00. */
export function formatDisplayTime(
  timestampMs: number,
  clock: ClockFormat = "locale",
  { locale, timeZone }: FormattingContext = {},
): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    ...(clock === "locale" ? {} : { hourCycle: clock === "12h" ? "h12" : "h23" }),
  }).format(new Date(timestampMs));
}

/** Numeric presets use Gregorian dates without changing the user's time zone. */
export function formatDisplayDate(
  timestampMs: number,
  format: DateFormat,
  { locale, timeZone }: FormattingContext = {},
): string {
  const date = new Date(timestampMs);
  if (format === "locale") {
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone,
    }).format(date);
  }
  const parts = new Intl.DateTimeFormat(locale, {
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (format === "year-first") return `${year}-${month}-${day}`;
  if (format === "day-first") return `${day}/${month}/${year}`;
  return `${month}/${day}/${year}`;
}
