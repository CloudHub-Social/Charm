import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useFlag } from "@/featureFlags";

interface SectionProps {
  title: string;
  count: number;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: React.ReactNode;
}

/** Collapsible room-list section (Favourites / Rooms / Low priority / a space's rooms) — Spec 06. */
export function RoomListSection({
  title,
  count,
  expanded,
  onExpandedChange,
  children,
}: SectionProps) {
  const uxRefreshEnabled = useFlag("ux_refresh_v1");
  if (count === 0) return null;

  return (
    <Collapsible open={expanded} onOpenChange={onExpandedChange}>
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground",
          uxRefreshEnabled && "mt-1 min-h-11 px-2 text-[11px] tracking-[0.12em]",
        )}
      >
        <ChevronDown className={cn("size-3.5 transition-transform", !expanded && "-rotate-90")} />
        {title}
        <span className="ml-auto font-normal normal-case">{count}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className={cn("flex flex-col gap-0.5", uxRefreshEnabled && "gap-1")}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
