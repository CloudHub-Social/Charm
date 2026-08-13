import { useEffect, useRef, useState } from "react";
import { useAtom } from "jotai";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useFlag } from "@/featureFlags";
import { useAdaptiveLayout } from "@/features/shell/useAdaptiveLayout";
import { cn } from "@/lib/utils";
import { roomSettingsAtom, type RoomSettingsSection } from "./roomInfoAtoms";
import { useRoomDetails } from "./useRoomDetails";
import { RoomSettingsForm } from "./RoomSettingsForm";
import { PowerLevelThresholdsEditor } from "./PowerLevelEditor";
import { MemberList } from "./MemberList";
import { SpaceChildrenSettings } from "./SpaceChildrenSettings";
import type { RoomDetails, RoomSummary } from "@/lib/matrix";

const SECTIONS: { value: RoomSettingsSection; label: string }[] = [
  { value: "general", label: "General" },
  { value: "members", label: "Members" },
  { value: "permissions", label: "Permissions" },
];

interface RoomSettingsModalProps {
  currentUserId: string;
  rooms?: RoomSummary[];
  onSpaceChildrenChanged?: () => void;
  onNavigateToRoom?: (roomId: string) => void;
  onRoomUpgraded?: (replacementRoomId: string) => void | Promise<void>;
}

const EMPTY_ROOMS: RoomSummary[] = [];

function withMutationsDisabled(details: RoomDetails): RoomDetails {
  return {
    ...details,
    can: Object.fromEntries(
      Object.keys(details.can).map((key) => [key, false]),
    ) as RoomDetails["can"],
  };
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
export function RoomSettingsModal({
  currentUserId,
  rooms = EMPTY_ROOMS,
  onSpaceChildrenChanged,
  onNavigateToRoom,
  onRoomUpgraded,
}: RoomSettingsModalProps) {
  const [target, setTarget] = useAtom(roomSettingsAtom);
  const targetRoomId = target?.roomId ?? null;
  const {
    data: details,
    isLoading,
    isError,
    isFetching,
    isRefetchError,
  } = useRoomDetails(targetRoomId, Boolean(targetRoomId));
  // Below `sm`, `DialogContent` becomes a full-screen sheet but is still
  // only ~320-375px wide — a fixed `w-48` side nav left too little room for
  // the settings pane (Room name/topic, Members search/sort) to be usable.
  // Switch to a horizontal top nav + stacked content on mobile instead,
  // matching `AppShell`'s existing sidebar-vs-bottom-nav breakpoint.
  const layout = useAdaptiveLayout();
  const isMobile = layout === "mobile";
  const roomAliasManagementEnabled = useFlag("room_alias_management");
  const spaceHierarchyEnabled = useFlag("space_hierarchy_reorganization");
  const activeTargetLabel = target?.kind === "space" ? "space" : "room";
  const [lastTargetLabel, setLastTargetLabel] = useState<"room" | "space">(activeTargetLabel);

  useEffect(() => {
    if (target) {
      setLastTargetLabel(activeTargetLabel);
    }
  }, [activeTargetLabel, target]);

  // Radix keeps the dialog mounted while its exit animation runs. Preserve
  // the last concrete target so its accessible name does not briefly change
  // from "Space settings" to "Room settings" after the atom is cleared.
  const targetLabel = target ? activeTargetLabel : lastTargetLabel;

  useEffect(() => {
    if (target?.kind === "space" && !spaceHierarchyEnabled) {
      setTarget(null);
    }
  }, [setTarget, spaceHierarchyEnabled, target?.kind]);

  const visibleTarget = target?.kind === "space" && !spaceHierarchyEnabled ? null : target;
  const roomMutationsBlocked =
    target?.kind !== "space" && (isFetching || isRefetchError || Boolean(details?.tombstone));
  const roomMutationsBlockedRef = useRef(roomMutationsBlocked);
  roomMutationsBlockedRef.current = roomMutationsBlocked;
  const renderedDetails =
    details && roomMutationsBlocked ? withMutationsDisabled(details) : details;

  return (
    <Dialog open={visibleTarget !== null} onOpenChange={(open) => !open && setTarget(null)}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "flex h-full max-h-full w-full max-w-full flex-col gap-0 rounded-none p-0 sm:h-[600px] sm:max-h-[85dvh] sm:max-w-3xl sm:rounded-lg",
          isMobile &&
            "pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]",
        )}
      >
        <DialogTitle className="sr-only">
          {targetLabel === "space" ? "Space settings" : "Room settings"}
        </DialogTitle>

        {isLoading && (
          <div className="flex items-center justify-between p-4">
            <p className="text-sm text-muted-foreground">Loading…</p>
            <button
              type="button"
              aria-label={`Close ${targetLabel} settings`}
              onClick={() => setTarget(null)}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        )}

        {isError && (
          <div className="flex items-center justify-between p-4">
            <p className="text-sm text-destructive">Couldn't load {targetLabel} settings.</p>
            <button
              type="button"
              aria-label={`Close ${targetLabel} settings`}
              onClick={() => setTarget(null)}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        )}

        {renderedDetails && target && (
          <TooltipProvider>
            <Tabs
              orientation={isMobile ? "horizontal" : "vertical"}
              value={target.section}
              onValueChange={(value) =>
                setTarget({
                  roomId: target.roomId,
                  section: value as RoomSettingsSection,
                  kind: target.kind,
                })
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
                    {/* Prefer the room name, then (behind the room_alias_management flag) a canonical alias (Spec 32), over the raw room id — the id is the least human-readable fallback. */}
                    {renderedDetails.name ??
                      (roomAliasManagementEnabled ? renderedDetails.canonical_alias : null) ??
                      renderedDetails.room_id}
                  </span>
                  <button
                    type="button"
                    aria-label={`Close ${targetLabel} settings`}
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
                  {spaceHierarchyEnabled && target.kind === "space" && (
                    <TabsTrigger value="children">Children</TabsTrigger>
                  )}
                </TabsList>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                {roomMutationsBlocked && (
                  <output className="m-4 block rounded-md border border-border bg-secondary px-3 py-2 text-sm text-muted-foreground">
                    {isFetching && !details?.tombstone
                      ? "Checking current room state. Settings changes are temporarily unavailable."
                      : "This room is read-only. Settings changes are unavailable here."}
                  </output>
                )}
                {/* `forceMount` + `data-[state=inactive]:hidden` keeps
                    General/Permissions mounted rather than letting Radix
                    unmount the inactive `TabsContent` — without this,
                    switching away and back reset any unsaved name/topic/
                    power-level edit, since that draft state lives in local
                    `useState` seeded from `details` on mount. Members is
                    deliberately excluded: it has no local draft to lose
                    (search/sort/filter are just UI state, not data at risk),
                    and `MemberList` eagerly calls `useRoomMembers` on mount
                    — forcing it whenever settings opens to General or
                    Permissions would fetch the full member roster before
                    the user ever asks for it. */}
                <TabsContent value="general" forceMount className="data-[state=inactive]:hidden">
                  <RoomSettingsForm
                    details={renderedDetails}
                    isSpace={target.kind === "space"}
                    mutationsBlockedRef={roomMutationsBlockedRef}
                    onRoomUpgraded={async (replacementRoomId) => {
                      await onRoomUpgraded?.(replacementRoomId);
                      setTarget(null);
                    }}
                  />
                </TabsContent>
                <TabsContent value="members">
                  <MemberList
                    details={renderedDetails}
                    currentUserId={currentUserId}
                    onNavigateToRoom={onNavigateToRoom}
                  />
                </TabsContent>
                <TabsContent
                  value="permissions"
                  forceMount
                  className="data-[state=inactive]:hidden"
                >
                  <PowerLevelThresholdsEditor details={renderedDetails} />
                </TabsContent>
                {spaceHierarchyEnabled && target.kind === "space" && (
                  <TabsContent value="children">
                    <SpaceChildrenSettings
                      spaceId={renderedDetails.room_id}
                      spaceName={renderedDetails.name}
                      rooms={rooms}
                      canEdit={renderedDetails.can.set_space_child && !isFetching && !isError}
                      onChanged={onSpaceChildrenChanged}
                    />
                  </TabsContent>
                )}
              </div>
            </Tabs>
          </TooltipProvider>
        )}
      </DialogContent>
    </Dialog>
  );
}
