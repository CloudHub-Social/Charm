function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "Today" / "Yesterday" / a full date, for the date divider above the first message of a day. */
export function formatDateDividerLabel(timestampMs: number, now = new Date()): string {
  const date = new Date(timestampMs);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(date, now)) return "Today";
  if (isSameDay(date, yesterday)) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(date);
}

/** Whether `messages[index]` starts a new calendar day relative to the previous message. */
export function isDateDividerBoundary(
  messages: readonly { timestamp_ms: number }[],
  index: number,
): boolean {
  if (index === 0) return true;
  return !isSameDay(
    new Date(messages[index - 1].timestamp_ms),
    new Date(messages[index].timestamp_ms),
  );
}

/**
 * Index of the first message that should get the "New messages" divider
 * above it — the start of the last `unreadCount` messages in the array —
 * or -1 if there's nothing unread to mark.
 */
export function unreadDividerIndex(messageCount: number, unreadCount: number): number {
  if (unreadCount <= 0) return -1;
  return Math.max(0, messageCount - unreadCount);
}
