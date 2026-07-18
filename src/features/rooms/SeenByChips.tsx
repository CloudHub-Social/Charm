import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useFlag } from "@/featureFlags";
import { MAX_RECEIPT_AVATARS } from "./messageRowShared";
import { avatarColor, initials } from "./roomDisplay";

interface SeenByChipsProps {
  readers: string[];
  senderNameByUserId: Map<string, string>;
  className?: string;
}

/**
 * Read-receipt avatar chip stack shared by `BubbleMessageRow` and
 * `DiscordMessageRow`. Spec 05 shipped the capped stack (first
 * `MAX_RECEIPT_AVATARS`, collapsing the rest into a static "+N"); Spec 40
 * item 5 makes that "+N" (and, when nothing overflows, the stack itself)
 * clickable to open the full ordered "Seen by" list — `useReadReceipts`
 * already builds the complete `readers` array, this just exposes all of it
 * instead of only the count.
 *
 * Review fix: the interactive popover is gated on the `presence_privacy_controls`
 * flag (this whole file's own feature) so it can be dark-launched/killed
 * independently — the underlying avatar-chip stack itself predates this
 * flag (Spec 05) and must keep rendering regardless, falling back to the
 * original static (non-clickable) "+N" when the flag is off/killed.
 */
export function SeenByChips({ readers, senderNameByUserId, className }: SeenByChipsProps) {
  const expandableListEnabled = useFlag("presence_privacy_controls");
  if (readers.length === 0) return null;

  const overflowCount = readers.length - MAX_RECEIPT_AVATARS;
  const nameFor = (userId: string) => senderNameByUserId.get(userId) ?? userId;

  const stack = (
    <TooltipProvider>
      <div className={cn("flex items-center gap-[3px]", className)}>
        {readers.slice(0, MAX_RECEIPT_AVATARS).map((userId) => (
          <Tooltip key={userId}>
            <TooltipTrigger asChild>
              {/* tabIndex={0}: keyboard/screen-reader users can tab to a
                  chip and get the same "Read by {name}" info a mouse
                  hover gives — not just decorative. */}
              {/* oxlint-disable jsx-a11y/no-noninteractive-tabindex */}
              <span
                tabIndex={0}
                style={{ background: avatarColor(userId) }}
                className="flex size-3.5 shrink-0 items-center justify-center rounded-full text-[7px] font-bold text-white ring-1 ring-background"
              >
                {initials(userId, senderNameByUserId.get(userId) ?? null)}
              </span>
              {/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */}
            </TooltipTrigger>
            <TooltipContent>Read by {nameFor(userId)}</TooltipContent>
          </Tooltip>
        ))}
        {overflowCount > 0 &&
          (expandableListEnabled ? (
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`Seen by ${readers.length} people. Show full list.`}
                className="flex size-3.5 shrink-0 items-center justify-center rounded-full bg-muted text-[7px] font-bold text-muted-foreground ring-1 ring-background hover:bg-accent"
              >
                +{overflowCount}
              </button>
            </PopoverTrigger>
          ) : (
            <span className="flex size-3.5 shrink-0 items-center justify-center rounded-full bg-muted text-[7px] font-bold text-muted-foreground ring-1 ring-background">
              +{overflowCount}
            </span>
          ))}
      </div>
    </TooltipProvider>
  );

  if (!expandableListEnabled) return stack;

  return (
    <Popover>
      {stack}
      <PopoverContent className="w-56 p-2" align="start">
        <p className="mb-1 px-1 text-xs font-semibold text-foreground">Seen by {readers.length}</p>
        <ul className="max-h-60 space-y-1 overflow-y-auto">
          {readers.map((userId) => (
            <li
              key={userId}
              className="flex items-center gap-2 rounded px-1 py-1 text-sm text-foreground"
            >
              <span
                aria-hidden="true"
                style={{ background: avatarColor(userId) }}
                className="flex size-4 shrink-0 items-center justify-center rounded-full text-[8px] font-bold text-white"
              >
                {initials(userId, senderNameByUserId.get(userId) ?? null)}
              </span>
              <span className="truncate">{nameFor(userId)}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
