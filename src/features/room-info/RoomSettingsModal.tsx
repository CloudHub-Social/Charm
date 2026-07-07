import { useAtom } from "jotai";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
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
  const { data: details, isLoading } = useRoomDetails(target?.roomId ?? null);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
      <DialogContent
        showCloseButton={false}
        className="flex h-full max-h-full w-full max-w-full flex-col gap-0 rounded-none p-0 sm:h-[600px] sm:max-h-[85vh] sm:max-w-3xl sm:rounded-lg"
      >
        <DialogTitle className="sr-only">Room settings</DialogTitle>

        {isLoading && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}

        {details && target && (
          <TooltipProvider>
            <Tabs
              orientation="vertical"
              value={target.section}
              onValueChange={(value) =>
                setTarget({ roomId: target.roomId, section: value as RoomSettingsSection })
              }
              className="min-h-0 flex-1 flex-row"
            >
              <div className="flex w-48 shrink-0 flex-col border-r border-border p-4">
                <span className="mb-4 truncate text-base font-bold text-foreground">
                  {details.name ?? details.room_id}
                </span>
                <TabsList className="h-fit flex-col items-stretch bg-transparent p-0">
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
