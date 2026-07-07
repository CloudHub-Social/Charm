import { useMemo, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MembershipKind, RoomDetails, RoomMemberSummary } from "@/lib/matrix";
import { useRoomMembers } from "./useRoomMembers";
import { MemberRow } from "./MemberRow";
import { InviteMemberDialog } from "./InviteMemberDialog";

interface MemberListProps {
  details: RoomDetails;
  currentUserId: string;
}

type MembershipFilter = "join" | "invite" | "ban";
type SortOrder = "name" | "power_level";

const MEMBERSHIP_FILTER_LABELS: Record<MembershipFilter, string> = {
  join: "Joined",
  invite: "Invited",
  ban: "Banned",
};

const SORT_LABELS: Record<SortOrder, string> = {
  name: "Name",
  power_level: "Power level",
};

function memberLabel(member: RoomMemberSummary): string {
  return member.display_name ?? member.user_id;
}

function matchesFilter(membership: MembershipKind, filter: MembershipFilter): boolean {
  return membership === filter;
}

/**
 * Search/sort/filter live entirely client-side over the already-fetched
 * `useRoomMembers` list — the member roster is small enough (per-room, not
 * global) that a server-side query would just add IPC round-trips for no
 * real benefit, matching Spec 17's scope (member management UX, not a new
 * backend paging API).
 */
export function MemberList({ details, currentUserId }: MemberListProps) {
  const { data: members, isLoading } = useRoomMembers(details.room_id);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MembershipFilter>("join");
  const [sort, setSort] = useState<SortOrder>("name");

  const filtered = useMemo(() => {
    if (!members) return [];
    const q = query.trim().toLowerCase();
    return members
      .filter((member) => matchesFilter(member.membership, filter))
      .filter((member) => (q === "" ? true : memberLabel(member).toLowerCase().includes(q)))
      .toSorted((a, b) =>
        sort === "name"
          ? memberLabel(a).localeCompare(memberLabel(b))
          : b.power_level - a.power_level,
      );
  }, [members, query, filter, sort]);

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          {details.member_count} member{details.member_count === 1 ? "" : "s"}
        </h3>
        <InviteMemberDialog roomId={details.room_id} disabled={!details.can.invite} />
      </div>

      <Input
        placeholder="Search members"
        aria-label="Search members"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">
              {MEMBERSHIP_FILTER_LABELS[filter]}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup
              value={filter}
              onValueChange={(value) => setFilter(value as MembershipFilter)}
            >
              {(Object.keys(MEMBERSHIP_FILTER_LABELS) as MembershipFilter[]).map((key) => (
                <DropdownMenuRadioItem key={key} value={key}>
                  {MEMBERSHIP_FILTER_LABELS[key]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">
              Sort: {SORT_LABELS[sort]}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup
              value={sort}
              onValueChange={(value) => setSort(value as SortOrder)}
            >
              {(Object.keys(SORT_LABELS) as SortOrder[]).map((key) => (
                <DropdownMenuRadioItem key={key} value={key}>
                  {SORT_LABELS[key]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading members…</p>}

      {members && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground">No members match.</p>
      )}

      {members && filtered.length > 0 && (
        <div className="flex flex-col">
          {filtered.map((member) => (
            <MemberRow
              key={member.user_id}
              roomId={details.room_id}
              member={member}
              can={details.can}
              myPowerLevel={details.my_power_level}
              currentUserId={currentUserId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
