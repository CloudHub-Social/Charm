import type { RoomDetails, RoomMemberSummary } from "@/lib/matrix";
import { useRoomMembers } from "./useRoomMembers";
import { MemberRow } from "./MemberRow";
import { InviteMemberDialog } from "./InviteMemberDialog";

interface MemberListProps {
  details: RoomDetails;
  currentUserId: string;
}

function groupByMembership(members: RoomMemberSummary[]) {
  const active = members.filter((m) => m.membership === "join" || m.membership === "invite");
  const banned = members.filter((m) => m.membership === "ban");
  return { active, banned };
}

export function MemberList({ details, currentUserId }: MemberListProps) {
  const { data: members, isLoading } = useRoomMembers(details.room_id);

  return (
    <div className="flex flex-col gap-2 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          {details.member_count} member{details.member_count === 1 ? "" : "s"}
        </h3>
        <InviteMemberDialog roomId={details.room_id} disabled={!details.can.invite} />
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading members…</p>}

      {members &&
        (() => {
          const { active, banned } = groupByMembership(members);
          return (
            <>
              <div className="flex flex-col">
                {active.map((member) => (
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
              {banned.length > 0 && (
                <div className="flex flex-col gap-1">
                  <h4 className="px-4 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Banned
                  </h4>
                  {banned.map((member) => (
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
            </>
          );
        })()}
    </div>
  );
}
