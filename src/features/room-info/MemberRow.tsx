import { useState } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { avatarColor, initials } from "@/features/rooms/roomDisplay";
import type { RoomMemberSummary, RoomPermissions } from "@/lib/matrix";
import { useRoomAdminActions } from "./useRoomAdminActions";
import { MemberPowerLevelDialog } from "./PowerLevelEditor";

interface MemberRowProps {
  roomId: string;
  member: RoomMemberSummary;
  can: RoomPermissions;
  myPowerLevel: number;
}

export function MemberRow({ roomId, member, can, myPowerLevel }: MemberRowProps) {
  const actions = useRoomAdminActions(roomId);
  const [powerLevelDialogOpen, setPowerLevelDialogOpen] = useState(false);
  const label = member.display_name ?? member.user_id;
  const hasAnyAction = can.kick || can.ban || can.set_power_levels || member.membership === "ban";

  return (
    <div className="flex min-h-11 items-center gap-2 px-4 py-1.5">
      <Avatar size="sm">
        <AvatarFallback style={{ backgroundColor: avatarColor(member.user_id) }}>
          {initials(member.user_id, member.display_name)}
        </AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">
          {member.user_id} · PL {member.power_level}
        </span>
      </div>
      {hasAnyAction && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Actions for ${label}`}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              ⋯
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {member.membership === "ban" ? (
              <GatedItem
                allowed={can.ban}
                onSelect={() => actions.unban.mutate({ userId: member.user_id })}
              >
                Unban
              </GatedItem>
            ) : (
              <>
                <GatedItem
                  allowed={can.set_power_levels}
                  onSelect={() => setPowerLevelDialogOpen(true)}
                >
                  Set power level
                </GatedItem>
                <GatedItem
                  allowed={can.kick}
                  onSelect={() => actions.kick.mutate({ userId: member.user_id })}
                >
                  Kick
                </GatedItem>
                <GatedItem
                  allowed={can.ban}
                  variant="destructive"
                  onSelect={() => actions.ban.mutate({ userId: member.user_id })}
                >
                  Ban
                </GatedItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <MemberPowerLevelDialog
        roomId={roomId}
        userId={member.user_id}
        currentPowerLevel={member.power_level}
        myPowerLevel={myPowerLevel}
        open={powerLevelDialogOpen}
        onOpenChange={setPowerLevelDialogOpen}
      />
    </div>
  );
}

interface GatedItemProps {
  allowed: boolean;
  variant?: "default" | "destructive";
  onSelect: () => void;
  children: React.ReactNode;
}

/** A dropdown item disabled-with-tooltip when the acting user's power level is insufficient. */
function GatedItem({ allowed, variant, onSelect, children }: GatedItemProps) {
  const item = (
    <DropdownMenuItem
      variant={variant}
      disabled={!allowed}
      onSelect={(e) => {
        if (!allowed) {
          e.preventDefault();
          return;
        }
        onSelect();
      }}
    >
      {children}
    </DropdownMenuItem>
  );
  if (allowed) return item;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{item}</TooltipTrigger>
      <TooltipContent side="left">You need a higher power level to do this</TooltipContent>
    </Tooltip>
  );
}
