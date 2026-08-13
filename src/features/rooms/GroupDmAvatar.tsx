import type { ReactNode } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PresenceDot, presenceColor, presenceLabel } from "@/features/presence/PresenceDot";
import { usePresence } from "@/features/presence/usePresence";
import { useResolvedAvatarSrc } from "@/features/profile/useResolvedAvatarSrc";
import type { GroupDmAvatarMember, PresenceStateDto } from "@/lib/matrix";
import { cn } from "@/lib/utils";
import { avatarColor, initials } from "./roomDisplay";

const PRESENCE_PRIORITY: Record<PresenceStateDto, number> = {
  offline: 0,
  unavailable: 1,
  dnd: 2,
  online: 3,
};

export function aggregateGroupPresence(
  presences: Array<PresenceStateDto | null | undefined>,
): PresenceStateDto | null {
  return presences.reduce<PresenceStateDto | null>((best, candidate) => {
    if (!candidate) return best;
    return !best || PRESENCE_PRIORITY[candidate] > PRESENCE_PRIORITY[best] ? candidate : best;
  }, null);
}

function GroupFace({ member, className }: { member: GroupDmAvatarMember; className: string }) {
  const avatarSrc = useResolvedAvatarSrc(member.avatar_url);
  return (
    <Avatar className={cn("absolute size-5 ring-2 ring-background", className)}>
      <AvatarImage src={avatarSrc} alt="" />
      <AvatarFallback
        style={{ background: avatarColor(member.user_id) }}
        className="text-[9px] font-bold text-white"
      >
        {initials(member.user_id, member.display_name)}
      </AvatarFallback>
    </Avatar>
  );
}

/** Adds aggregate group presence around either a mosaic or an explicit room avatar. */
export function GroupDmPresenceAvatar({
  members,
  showPresenceRing,
  composite = false,
  children,
}: {
  members: GroupDmAvatarMember[];
  showPresenceRing: boolean;
  composite?: boolean;
  children: ReactNode;
}) {
  // Matrix caps room-summary heroes at five. Fixed hook slots preserve the
  // Rules of Hooks while still aggregating every hero the SDK can return.
  const p0 = usePresence(members[0]?.user_id ?? null);
  const p1 = usePresence(members[1]?.user_id ?? null);
  const p2 = usePresence(members[2]?.user_id ?? null);
  const p3 = usePresence(members[3]?.user_id ?? null);
  const p4 = usePresence(members[4]?.user_id ?? null);
  const aggregate = aggregateGroupPresence([
    p0?.presence,
    p1?.presence,
    p2?.presence,
    p3?.presence,
    p4?.presence,
  ]);
  return (
    <Avatar
      data-group-dm-avatar={composite ? "" : undefined}
      className="relative"
      style={
        showPresenceRing && aggregate
          ? { boxShadow: `0 0 0 2px ${presenceColor(aggregate)}` }
          : undefined
      }
    >
      {children}
      {aggregate && showPresenceRing && (
        <span className="sr-only">{presenceLabel(aggregate)} group presence</span>
      )}
      {aggregate && !showPresenceRing && (
        <PresenceDot presence={aggregate} insideInteractiveParent />
      )}
    </Avatar>
  );
}

/** Matrix room-summary heroes rendered as the Charm 1.0-style group-DM mosaic. */
export function GroupDmAvatar({
  members,
  showPresenceRing,
}: {
  members: GroupDmAvatarMember[];
  showPresenceRing: boolean;
}) {
  const faces = members.slice(0, 3);
  const positions =
    faces.length === 2
      ? ["left-0 top-0", "right-0 bottom-0"]
      : ["left-0 top-0", "right-0 top-0", "bottom-0 left-1/2 -translate-x-1/2"];

  return (
    <GroupDmPresenceAvatar members={members} showPresenceRing={showPresenceRing} composite>
      {faces.map((member, index) => (
        <GroupFace key={member.user_id} member={member} className={positions[index] ?? ""} />
      ))}
    </GroupDmPresenceAvatar>
  );
}
