import { useAtom } from "jotai";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAdaptiveLayout } from "@/features/shell/useAdaptiveLayout";
import { cn } from "@/lib/utils";
import { roomSettingsAtom, type RoomSettingsSection } from "./roomInfoAtoms";
import { useRoomDetails } from "./useRoomDetails";
import { RoomSettingsForm } from "./RoomSettingsForm";
import { PowerLevelThresholdsEditor } from "./PowerLevelEditor";
import { MemberList } from "./MemberList";

const SECTIONS: { value: RoomSettingsSection; label: string }[] = [
  { value: "general", label: "General" },
  { value: "members", label: "Members" },
  { value: "permissions", label: "Permissions" },
];

interface RoomSettingsModalProps {
  currentUserId: string;
}

/**
 * Room settings as a modal — full-screen on mobile, a centered card on
 * desktop — with a left-nav + detail-pane split (General / Members /
 * Permissions), replacing the Spec 07 permanent right-hand panel. Matches
 * Charm 1.0's `RoomSettings.tsx` structure/navigation, not its visual
 * styling (Spec 09's design system is unchanged). Mounted globally like
 * `SettingsScreen`, reading its target room/section from `roomSettingsAtom`
 * rather than being conditionally rendered by a parent.
 */
export function RoomSettingsModal({ currentUserId }: RoomSettingsModalProps) {
  const [target, setTarget] = useAtom(roomSettingsAtom);
  const { data: details, isLoading, isError } = useRoomDetails(target?.roomId ?? null);
  // Below `sm`, `DialogContent` becomes a full-screen sheet but is still
  // only ~320-375px wide — a fixed `w-48` side nav left too little room for
  // the settings pane (Room name/topic, Members search/sort) to be usable.
  // Switch to a horizontal top nav + stacked content on mobile instead,
  // matching `AppShell`'s existing sidebar-vs-bottom-nav breakpoint.
  const layout = useAdaptiveLayout();
  const isMobile = layout === "mobile";

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
      <DialogContent
        showCloseButton={false}
        className="flex h-full max-h-full w-full max-w-full flex-col gap-0 rounded-none p-0 sm:h-[600px] sm:max-h-[85vh] sm:max-w-3xl sm:rounded-lg"
      >
        <DialogTitle className="sr-only">Room settings</DialogTitle>

        {isLoading && (
          <div className="flex items-center justify-between p-4">
            <p className="text-sm text-muted-foreground">Loading…</p>
            <button
              type="button"
              aria-label="Close room settings"
              onClick={() => setTarget(null)}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        )}

        {isError && (
          <div className="flex items-center justify-between p-4">
            <p className="text-sm text-destructive">Couldn't load room settings.</p>
            <button
              type="button"
              aria-label="Close room settings"
              onClick={() => setTarget(null)}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        )}

        {details && target && (
          <TooltipProvider>
            <Tabs
              orientation={isMobile ? "horizontal" : "vertical"}
              value={target.section}
              onValueChange={(value) =>
                setTarget({ roomId: target.roomId, section: value as RoomSettingsSection })
              }
              className={cn("min-h-0 flex-1", isMobile ? "flex-col" : "flex-row")}
            >
              <div
                className={cn(
                  "flex shrink-0 flex-col p-4",
                  isMobile ? "w-full border-b border-border" : "w-48 border-r border-border",
                )}
              >
                <div className="mb-4 flex items-center justify-between gap-2">
                  <span className="truncate text-base font-bold text-foreground">
                    {details.name ?? details.room_id}
                  </span>
                  <button
                    type="button"
                    aria-label="Close room settings"
                    onClick={() => setTarget(null)}
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  >
                    <X className="size-4" />
                  </button>
                </div>
                <TabsList
                  className={cn(
                    "h-fit items-stretch bg-transparent p-0",
                    isMobile ? "flex-row" : "flex-col",
                  )}
                >
                  {SECTIONS.map((section) => (
                    <TabsTrigger key={section.value} value={section.value}>
                      {section.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                <TabsContent value="general">
                  <RoomSettingsForm details={details} />
                </TabsContent>
                <TabsContent value="members">
                  <MemberList details={details} currentUserId={currentUserId} />
                </TabsContent>
                <TabsContent value="permissions">
                  <PowerLevelThresholdsEditor details={details} />
                </TabsContent>
              </div>
            </Tabs>
          </TooltipProvider>
        )}
      </DialogContent>
    </Dialog>
  );
}
