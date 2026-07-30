import { useState } from "react";
import type { TimelineItemSummary } from "@/lib/matrix";
import { cn } from "@/lib/utils";

export type TimelineNotice = Exclude<TimelineItemSummary, { kind: "message" }>;

export interface TimelineNoticeBuckets {
  beforeMessage: Map<string, TimelineNotice[]>;
  trailing: TimelineNotice[];
}

export function bucketTimelineNotices(
  items: TimelineItemSummary[],
  hideMembershipEvents: boolean,
  showHiddenEvents: boolean,
): TimelineNoticeBuckets {
  const beforeMessage = new Map<string, TimelineNotice[]>();
  let pending: TimelineNotice[] = [];

  for (const item of items) {
    if (item.kind === "message") {
      if (pending.length > 0) beforeMessage.set(item.message.event_id, pending);
      pending = [];
      continue;
    }
    if (item.kind === "membership" && hideMembershipEvents) continue;
    if (item.kind === "state" && item.change.type === "hidden" && !showHiddenEvents) continue;
    pending.push(item);
  }

  return { beforeMessage, trailing: pending };
}

function targetLabel(item: Extract<TimelineNotice, { kind: "membership" }>): string {
  return item.target_display_name ?? item.target_user_id;
}

function membershipVerb(item: Extract<TimelineNotice, { kind: "membership" }>): string {
  switch (item.change.type) {
    case "joined":
    case "invitation_accepted":
      return "joined";
    case "left":
      return "left";
    case "banned":
      return "was banned";
    case "unbanned":
      return "was unbanned";
    case "kicked":
      return "was kicked";
    case "invited":
      return "was invited";
    case "kicked_and_banned":
      return "was kicked and banned";
    case "invitation_rejected":
      return "rejected an invitation";
    case "invitation_revoked":
      return "had their invitation revoked";
    case "knocked":
      return "requested to join";
    case "knock_accepted":
      return "had their join request accepted";
    case "knock_retracted":
      return "withdrew their join request";
    case "knock_denied":
      return "had their join request denied";
    case "profile":
      return "updated their profile";
    case "unknown":
      return "changed membership";
  }
  return "changed membership";
}

function membershipLabel(item: Extract<TimelineNotice, { kind: "membership" }>): string {
  const target = targetLabel(item);
  if (item.change.type === "profile") {
    if (item.change.old_display_name !== item.change.new_display_name) {
      if (item.change.new_display_name) {
        return `${target} changed their display name to ${item.change.new_display_name}`;
      }
      return `${target} removed their display name`;
    }
    if (item.change.old_avatar_url !== item.change.new_avatar_url) {
      return `${target} changed their avatar`;
    }
  }
  const actor =
    item.sender !== item.target_user_id &&
    ["banned", "kicked", "kicked_and_banned", "invited", "invitation_revoked"].includes(
      item.change.type,
    )
      ? ` by ${item.sender}`
      : "";
  const reason = item.reason ? `: ${item.reason}` : "";
  return `${target} ${membershipVerb(item)}${actor}${reason}`;
}

function stateLabel(item: Extract<TimelineNotice, { kind: "state" }>): string {
  switch (item.change.type) {
    case "name":
      return item.change.new_value
        ? `${item.sender} changed the room name to ${item.change.new_value}`
        : `${item.sender} removed the room name`;
    case "topic":
      return item.change.new_value
        ? `${item.sender} changed the topic to ${item.change.new_value}`
        : `${item.sender} removed the room topic`;
    case "avatar":
      return item.change.new_value
        ? `${item.sender} changed the room avatar`
        : `${item.sender} removed the room avatar`;
    case "tombstone":
      return item.change.body ?? "This room has been replaced by a newer room";
    case "hidden":
      return `${item.sender} changed ${item.change.event_type}`;
  }
  return `${item.sender} changed room state`;
}

function collapsedMembershipLabel(
  items: Extract<TimelineNotice, { kind: "membership" }>[],
): string {
  const names = items.map(targetLabel);
  const subject =
    names.length === 2
      ? `${names[0]} and ${names[1]}`
      : `${names[0]}, ${names[1]} and ${names.length - 2} others`;
  return `${subject} ${membershipVerb(items[0])}`;
}

function NoticeLine({ children, irc }: { children: string; irc: boolean }) {
  return (
    <p
      className={cn(
        "break-words text-xs text-muted-foreground",
        irc ? "py-0.5 font-mono" : "py-1 text-center",
      )}
    >
      {irc && "* "}
      {children}
    </p>
  );
}

export function TimelineNoticeList({
  notices,
  irc = false,
}: {
  notices: TimelineNotice[];
  irc?: boolean;
}) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const groups: TimelineNotice[][] = [];
  for (const notice of notices) {
    const previous = groups.at(-1);
    if (
      notice.kind === "membership" &&
      previous?.[0]?.kind === "membership" &&
      previous[0].change.type === notice.change.type
    ) {
      previous.push(notice);
    } else {
      groups.push([notice]);
    }
  }

  return (
    <div className="my-1" data-testid="timeline-notices">
      {groups.map((group) => {
        const first = group[0];
        const collapsible = group.length > 1 && first.kind === "membership";
        const expanded = expandedGroups.has(first.event_id);
        if (collapsible && !expanded) {
          return (
            <button
              key={first.event_id}
              type="button"
              className={cn(
                "block w-full text-xs text-muted-foreground hover:text-foreground",
                irc ? "py-0.5 text-left font-mono" : "py-1 text-center",
              )}
              aria-expanded="false"
              onClick={() => setExpandedGroups((current) => new Set(current).add(first.event_id))}
            >
              {irc && "* "}
              {collapsedMembershipLabel(group as Extract<TimelineNotice, { kind: "membership" }>[])}
            </button>
          );
        }
        return group.map((notice) => (
          <NoticeLine key={notice.event_id} irc={irc}>
            {notice.kind === "membership" ? membershipLabel(notice) : stateLabel(notice)}
          </NoticeLine>
        ));
      })}
    </div>
  );
}
