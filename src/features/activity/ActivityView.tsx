import { Bell, CheckCircle2, MessageCircle, Sparkles, UserPlus } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { RoomSummary } from "@/lib/matrix";
import { avatarColor, displayName, initials, resolveAvatar } from "@/features/rooms/roomDisplay";
import { activityRooms } from "./activityModel";

interface ActivityViewProps {
  rooms: RoomSummary[];
  onSelectRoom: (roomId: string) => void;
}

export function ActivityView({ rooms, onSelectRoom }: ActivityViewProps) {
  const items = activityRooms(rooms);
  const inviteCount = items.filter((room) => room.membership === "invite").length;
  const notificationCount = items.reduce(
    (sum, room) =>
      room.membership === "invite" ? sum : sum + Math.max(1, room.unread_count),
    0,
  );

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--ux-content-bg)] text-foreground pt-[env(safe-area-inset-top)]">
      <header className="flex min-h-20 items-end justify-between border-b border-[var(--ux-shell-border)] px-5 pb-3 sm:min-h-18 sm:items-center sm:px-8 sm:pb-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="hidden size-9 items-center justify-center rounded-xl bg-[var(--ux-selection)] text-[var(--ux-selection-strong)] sm:flex">
              <Bell className="size-4.5" aria-hidden="true" />
            </span>
            <h1 className="text-2xl font-bold tracking-[-0.025em] sm:text-lg sm:tracking-[-0.015em]">
              Activity
            </h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Invites, notifications, and conversations that need you.
          </p>
        </div>
        {(inviteCount > 0 || notificationCount > 0) && (
          <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
            {inviteCount > 0 && (
              <span>
                {inviteCount} invite{inviteCount === 1 ? "" : "s"}
              </span>
            )}
            {inviteCount > 0 && notificationCount > 0 && <span aria-hidden="true">·</span>}
            {notificationCount > 0 && (
              <span>
                {notificationCount} notification{notificationCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          {items.length === 0 ? (
            <div className="flex min-h-80 flex-col items-center justify-center rounded-3xl border border-[var(--ux-shell-border)] bg-[var(--ux-content-raised)] px-8 text-center">
              <span className="flex size-14 items-center justify-center rounded-2xl bg-[var(--ux-selection)] text-[var(--ux-presence)]">
                <CheckCircle2 className="size-7" aria-hidden="true" />
              </span>
              <h2 className="mt-5 text-base font-bold">You’re all caught up</h2>
              <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">
                New invites and important room notifications will collect here without duplicating
                your rail badges.
              </p>
            </div>
          ) : (
            items.map((room) => {
              const invited = room.membership === "invite";
              const label = displayName(room.room_id, room.name);
              return (
                <button
                  key={room.room_id}
                  type="button"
                  onClick={() => onSelectRoom(room.room_id)}
                  className="group flex min-h-18 w-full items-center gap-3 rounded-2xl border border-transparent bg-[var(--ux-content-raised)] px-4 py-3 text-left shadow-[0_6px_20px_rgba(0,0,0,0.06)] transition active:scale-[0.99] active:opacity-75 sm:hover:-translate-y-px sm:hover:border-[var(--ux-shell-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ux-shell-focus)]"
                >
                  <Avatar size="lg" className="size-11">
                    <AvatarImage src={resolveAvatar(room.avatar_path, room.avatar_url)} alt="" />
                    <AvatarFallback
                      style={{ background: avatarColor(room.room_id) }}
                      className="text-xs font-bold text-white"
                    >
                      {initials(room.room_id, room.name)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-bold">{label}</span>
                      {room.is_direct && (
                        <MessageCircle
                          className="size-3.5 text-muted-foreground"
                          aria-hidden="true"
                        />
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-sm text-muted-foreground">
                      {invited
                        ? `${room.inviter_display_name ?? room.inviter_user_id ?? "Someone"} invited you`
                        : (room.last_message_preview?.text ?? "Open the conversation")}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {invited ? (
                      <span className="flex items-center gap-1 rounded-full bg-[var(--ux-selection)] px-2.5 py-1 text-xs font-semibold text-[var(--ux-selection-strong)]">
                        <UserPlus className="size-3.5" aria-hidden="true" /> Invite
                      </span>
                    ) : room.unread_count > 0 ? (
                      <span className="flex min-w-7 items-center justify-center rounded-full bg-[var(--ux-badge)] px-2 py-1 text-xs font-bold text-[var(--ux-badge-text)]">
                        {room.unread_count}
                      </span>
                    ) : (
                      <Sparkles className="size-4 text-[var(--ux-favourite)]" aria-hidden="true" />
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </main>
  );
}
