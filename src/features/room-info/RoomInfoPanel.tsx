import { X } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useRoomDetails } from "./useRoomDetails";
import { RoomSettingsForm } from "./RoomSettingsForm";
import { PowerLevelThresholdsEditor } from "./PowerLevelEditor";
import { MemberList } from "./MemberList";

interface RoomInfoPanelProps {
  roomId: string;
  onClose: () => void;
}

/**
 * The Spec 07 right panel — Info (room settings + power-level thresholds)
 * and Members tabs, plus a disabled Pinned stub (Day-2, per the spec's
 * non-goals). Rendered as a third column by `RoomsScreen` when
 * `rightPanelOpenAtomFamily(roomId)` is true.
 */
export function RoomInfoPanel({ roomId, onClose }: RoomInfoPanelProps) {
  const { data: details, isLoading } = useRoomDetails(roomId);

  return (
    <div className="flex w-80 shrink-0 flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border p-4">
        <h2 className="text-[15px] font-bold text-foreground">Room info</h2>
        <button
          type="button"
          aria-label="Close room info"
          onClick={onClose}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      {isLoading && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}

      {details && (
        <TooltipProvider>
          <Tabs defaultValue="info" className="min-h-0 flex-1">
            <TabsList className="mx-4 mt-3">
              <TabsTrigger value="info">Info</TabsTrigger>
              <TabsTrigger value="members">Members</TabsTrigger>
              <TabsTrigger value="pinned" disabled>
                Pinned
              </TabsTrigger>
            </TabsList>
            <TabsContent value="info" className="overflow-y-auto">
              <RoomSettingsForm details={details} />
              <div className="border-t border-border">
                <PowerLevelThresholdsEditor details={details} />
              </div>
            </TabsContent>
            <TabsContent value="members" className="overflow-y-auto">
              <MemberList details={details} />
            </TabsContent>
            <TabsContent value="pinned">
              <p className="p-4 text-sm text-muted-foreground">Coming soon</p>
            </TabsContent>
          </Tabs>
        </TooltipProvider>
      )}
    </div>
  );
}
