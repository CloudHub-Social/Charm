import { type ReactNode, useState } from "react";
import type { TimelineItemSummary } from "@/lib/matrix";
import { cn } from "@/lib/utils";
import { formatDateDividerLabel, isDateDividerBetween } from "./timelineDividers";

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
    if (
      item.kind === "state" &&
      (item.change.type === "name" ||
        item.change.type === "topic" ||
        item.change.type === "avatar") &&
      item.change.old_value === item.change.new_value
    ) {
      continue;
    }
    pending.push(item);
  }

  return { beforeMessage, trailing: pending };
}

function safeRemoteText(value: string): string {
  return value
    .replace(/\p{Cc}/gu, " ")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

function RemoteText({ children }: { children: string }) {
  return <bdi>{safeRemoteText(children)}</bdi>;
}

function TargetIdentity({
  item,
  displayName = item.target_display_name,
}: {
  item: Extract<TimelineNotice, { kind: "membership" }>;
  displayName?: string | null;
}) {
  if (!displayName || displayName === item.target_user_id) {
    return <RemoteText>{item.target_user_id}</RemoteText>;
  }
  return (
    <>
      <RemoteText>{displayName}</RemoteText>
      {" ("}
      <RemoteText>{item.target_user_id}</RemoteText>
      {")"}
    </>
  );
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

function membershipLabel(item: Extract<TimelineNotice, { kind: "membership" }>): ReactNode {
  if (item.change.type === "profile") {
    const displayNameChanged = item.change.old_display_name !== item.change.new_display_name;
    const avatarChanged = item.change.old_avatar_url !== item.change.new_avatar_url;
    if (displayNameChanged || avatarChanged) {
      return (
        <>
          <TargetIdentity item={item} displayName={item.change.old_display_name} />{" "}
          {displayNameChanged &&
            (item.change.new_display_name ? (
              <>
                changed their display name to{" "}
                <RemoteText>{item.change.new_display_name}</RemoteText>
              </>
            ) : (
              "removed their display name"
            ))}
          {displayNameChanged && avatarChanged && " and "}
          {avatarChanged && "changed their avatar"}
        </>
      );
    }
  }
  const showActor =
    item.sender !== item.target_user_id &&
    [
      "banned",
      "unbanned",
      "kicked",
      "kicked_and_banned",
      "invited",
      "invitation_revoked",
      "knock_accepted",
      "knock_denied",
    ].includes(item.change.type);
  return (
    <>
      <TargetIdentity item={item} /> {membershipVerb(item)}
      {showActor && (
        <>
          {" by "}
          <RemoteText>{item.sender}</RemoteText>
        </>
      )}
      {item.reason && (
        <>
          {": "}
          <RemoteText>{item.reason}</RemoteText>
        </>
      )}
    </>
  );
}

function stateLabel(item: Extract<TimelineNotice, { kind: "state" }>): ReactNode {
  const actor = <RemoteText>{item.sender}</RemoteText>;
  switch (item.change.type) {
    case "name":
      return item.change.new_value ? (
        <>
          {actor} changed the room name to <RemoteText>{item.change.new_value}</RemoteText>
        </>
      ) : (
        <>{actor} removed the room name</>
      );
    case "topic":
      return item.change.new_value ? (
        <>
          {actor} changed the topic to <RemoteText>{item.change.new_value}</RemoteText>
        </>
      ) : (
        <>{actor} removed the room topic</>
      );
    case "avatar":
      return item.change.new_value ? (
        <>{actor} changed the room avatar</>
      ) : (
        <>{actor} removed the room avatar</>
      );
    case "tombstone":
      return (
        <>
          This room was upgraded
          {item.change.body && (
            <>
              {": "}
              <RemoteText>{item.change.body}</RemoteText>
            </>
          )}
          {item.change.replacement_room_id && (
            <>
              {" — replacement "}
              <RemoteText>{item.change.replacement_room_id}</RemoteText>
            </>
          )}
        </>
      );
    case "redacted":
      return (
        <>
          A <RemoteText>{item.change.event_type}</RemoteText> state event was redacted
        </>
      );
    case "hidden":
      return (
        <>
          {actor} changed <RemoteText>{item.change.event_type}</RemoteText>
          {item.state_key && (
            <>
              {" for state key "}
              <RemoteText>{item.state_key}</RemoteText>
            </>
          )}
        </>
      );
  }
  return <>{actor} changed room state</>;
}

function collapsedMembershipLabel(
  items: Extract<TimelineNotice, { kind: "membership" }>[],
): ReactNode {
  return (
    <>
      <TargetIdentity item={items[0]} />
      {items.length === 2 ? " and " : ", "}
      <TargetIdentity item={items[1]} />
      {items.length > 2
        ? ` and ${items.length - 2} other${items.length === 3 ? "" : "s"}`
        : ""}{" "}
      {membershipVerb(items[0])}
    </>
  );
}

function NoticeLine({ children, irc }: { children: ReactNode; irc: boolean }) {
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
  previousTimestampMs = null,
}: {
  notices: TimelineNotice[];
  irc?: boolean;
  previousTimestampMs?: number | null;
}) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const groups: TimelineNotice[][] = [];
  for (const notice of notices) {
    const previous = groups.at(-1);
    if (
      notice.kind === "membership" &&
      previous?.[0]?.kind === "membership" &&
      previous[0].change.type === notice.change.type &&
      !isDateDividerBetween(previous.at(-1)?.timestamp_ms ?? null, notice.timestamp_ms)
    ) {
      previous.push(notice);
    } else {
      groups.push([notice]);
    }
  }

  return (
    <div className="my-1" data-testid="timeline-notices">
      {groups.map((group, groupIndex) => {
        const first = group[0];
        const previousTimestamp =
          groupIndex === 0 ? previousTimestampMs : groups[groupIndex - 1].at(-1)!.timestamp_ms;
        const showDateDivider = isDateDividerBetween(previousTimestamp, first.timestamp_ms);
        const collapsible = group.length > 1 && first.kind === "membership";
        const expanded = expandedGroups.has(first.event_id);
        if (collapsible && !expanded) {
          return (
            <div key={first.event_id}>
              {showDateDivider && (
                <div className="my-2 flex items-center gap-3 text-xs font-semibold text-muted-foreground">
                  {formatDateDividerLabel(first.timestamp_ms)}
                </div>
              )}
              <button
                type="button"
                className={cn(
                  "block w-full text-xs text-muted-foreground hover:text-foreground",
                  irc ? "py-0.5 text-left font-mono" : "py-1 text-center",
                )}
                aria-expanded="false"
                onClick={() => setExpandedGroups((current) => new Set(current).add(first.event_id))}
              >
                {irc && "* "}
                {collapsedMembershipLabel(
                  group as Extract<TimelineNotice, { kind: "membership" }>[],
                )}
              </button>
            </div>
          );
        }
        return (
          <div key={first.event_id}>
            {showDateDivider && (
              <div className="my-2 flex items-center gap-3 text-xs font-semibold text-muted-foreground">
                {formatDateDividerLabel(first.timestamp_ms)}
              </div>
            )}
            {group.map((notice) => (
              <NoticeLine key={notice.event_id} irc={irc}>
                {notice.kind === "membership" ? membershipLabel(notice) : stateLabel(notice)}
              </NoticeLine>
            ))}
          </div>
        );
      })}
    </div>
  );
}
