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
  currentUserId: string;
}

export function MemberRow({ roomId, member, can, myPowerLevel, currentUserId }: MemberRowProps) {
  const actions = useRoomAdminActions(roomId);
  const [powerLevelDialogOpen, setPowerLevelDialogOpen] = useState(false);
  const label = member.display_name ?? member.user_id;
  const isSelf = member.user_id === currentUserId;
  // Matrix rejects kick/ban (and power-level edits) of a member at or above
  // the acting user's own power level regardless of the room's kick/ban
  // threshold — gating on the room-wide `can.*` alone would show an enabled
  // control that's guaranteed to fail server-side against a peer admin.
  const targetOutranked = member.power_level < myPowerLevel;
  const kickAllowed = can.kick && targetOutranked;
  const banAllowed = can.ban && targetOutranked;
  const setPowerLevelAllowed = can.set_power_levels && (isSelf || targetOutranked);
  // Unbanning is a membership change to "leave" for a banned target, which
  // Matrix authorizes on *both* the ban check and the kick-level check, not
  // ban alone — a room with a higher kick threshold than ban threshold would
  // otherwise show an Unban that's guaranteed to fail server-side.
  const unbanAllowed = can.ban && can.kick;
  // For an active member, the menu still opens (showing whichever of
  // kick/ban/set-power-level is disabled-with-tooltip) even if none of the
  // *target-specific* refinements above pass, so the row explains why. A
  // banned member has only one possible action, so there's nothing useful to
  // show if that one action isn't available — hide the menu entirely instead
  // of a single disabled item.
  const hasAnyAction =
    member.membership === "ban" ? unbanAllowed : can.kick || can.ban || can.set_power_levels;

  return (
    <div className="flex min-h-11 items-center gap-2 px-4 py-1.5">
      <Avatar size="sm">
        {/* `text-white`: AvatarFallback's default is `text-muted-foreground`
            (meant for the no-color placeholder state) — without an explicit
            override it renders muted-gray text on the colorful
            `avatarColor()` background at ~1.5:1, real WCAG AA failures. */}
        <AvatarFallback
          style={{ backgroundColor: avatarColor(member.user_id) }}
          className="text-white"
        >
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
                allowed={unbanAllowed}
                onSelect={() => actions.unban.mutate({ userId: member.user_id })}
              >
                Unban
              </GatedItem>
            ) : (
              <>
                <GatedItem
                  allowed={setPowerLevelAllowed}
                  onSelect={() => setPowerLevelDialogOpen(true)}
                >
                  Set power level
                </GatedItem>
                <GatedItem
                  allowed={kickAllowed}
                  onSelect={() => actions.kick.mutate({ userId: member.user_id })}
                >
                  Kick
                </GatedItem>
                <GatedItem
                  allowed={banAllowed}
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
        isSelf={isSelf}
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
  // `DropdownMenuItem`'s disabled state sets `pointer-events: none` on the
  // item itself, so a `TooltipTrigger asChild` wrapping it directly never
  // sees the hover — wrap it in a plain (non-disabled) span instead so the
  // tooltip actually triggers, same pattern as `RoomSettingsForm`'s
  // `PermissionGate`.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block">{item}</span>
      </TooltipTrigger>
      <TooltipContent side="left">You need a higher power level to do this</TooltipContent>
    </Tooltip>
  );
}
