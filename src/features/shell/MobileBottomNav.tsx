import { Bell, MessageSquare, Settings, UsersRound, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface MobileBottomNavProps {
  refresh: boolean;
  chatsActive: boolean;
  activityActive: boolean;
  spacesActive: boolean;
  settingsActive: boolean;
  showActivity: boolean;
  showSpaces: boolean;
  onSelectChats: () => void;
  onSelectActivity?: () => void;
  onSelectSpaces?: () => void;
  onSelectSettings: () => void;
}

export function MobileBottomNav({
  refresh,
  chatsActive,
  activityActive,
  spacesActive,
  settingsActive,
  showActivity,
  showSpaces,
  onSelectChats,
  onSelectActivity,
  onSelectSpaces,
  onSelectSettings,
}: MobileBottomNavProps) {
  return (
    <nav
      className={cn(
        "flex shrink-0 border-t bg-background pb-[env(safe-area-inset-bottom)]",
        refresh &&
          "border-[var(--ux-shell-border)] bg-[var(--ux-sidebar-bg)] px-2 pt-1 backdrop-blur-xl",
      )}
      aria-label="Primary"
    >
      <Tab icon={MessageSquare} label="Chats" active={chatsActive} onClick={onSelectChats} />
      {showActivity && onSelectActivity && (
        <Tab icon={Bell} label="Activity" active={activityActive} onClick={onSelectActivity} />
      )}
      {showSpaces && onSelectSpaces && (
        <Tab icon={UsersRound} label="Spaces" active={spacesActive} onClick={onSelectSpaces} />
      )}
      <Tab icon={Settings} label="Settings" active={settingsActive} onClick={onSelectSettings} />
    </nav>
  );
}

function Tab({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      className="flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg py-1 text-xs text-muted-foreground transition active:opacity-55 aria-[current=page]:text-[var(--ux-selection-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ux-shell-focus)]"
      onClick={onClick}
    >
      <Icon className="size-5" aria-hidden="true" />
      {label}
    </button>
  );
}
