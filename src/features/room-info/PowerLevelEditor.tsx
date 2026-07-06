import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PowerLevelThresholds, RoomDetails } from "@/lib/matrix";
import { useRoomAdminActions } from "./useRoomAdminActions";

const PRESET_ROLES = [
  { label: "Admin", value: 100 },
  { label: "Moderator", value: 50 },
  { label: "Default", value: 0 },
];

interface MemberPowerLevelDialogProps {
  roomId: string;
  userId: string;
  currentPowerLevel: number;
  myPowerLevel: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Sets one member's power level, via a preset-role select or a raw number.
 * Confirms before raising a target to/above the acting user's own power
 * level, and before the acting user demotes themself — both are hard to
 * reverse from the UI (see Spec 07's "PL edit foot-guns" risk note).
 */
export function MemberPowerLevelDialog({
  roomId,
  userId,
  currentPowerLevel,
  myPowerLevel,
  open,
  onOpenChange,
}: MemberPowerLevelDialogProps) {
  const actions = useRoomAdminActions(roomId);
  const [powerLevel, setPowerLevel] = useState(currentPowerLevel);
  const [confirming, setConfirming] = useState(false);

  const needsConfirm = powerLevel >= myPowerLevel;

  function commit() {
    actions.setMemberPowerLevel.mutate({ userId, powerLevel });
    onOpenChange(false);
    setConfirming(false);
  }

  function handleSave() {
    if (needsConfirm) {
      setConfirming(true);
      return;
    }
    commit();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set power level</DialogTitle>
          <DialogDescription>{userId}</DialogDescription>
        </DialogHeader>
        {confirming ? (
          <>
            <p className="text-sm text-muted-foreground">
              This sets a power level at or above your own — you may not be able to undo this
              yourself afterward. Continue?
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={commit}>
                Set power level
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              <div className="flex gap-2">
                {PRESET_ROLES.map((role) => (
                  <Button
                    key={role.label}
                    size="sm"
                    variant={powerLevel === role.value ? "default" : "outline"}
                    onClick={() => setPowerLevel(role.value)}
                  >
                    {role.label}
                  </Button>
                ))}
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="raw-power-level">Custom power level</Label>
                <Input
                  id="raw-power-level"
                  type="number"
                  value={powerLevel}
                  onChange={(e) => setPowerLevel(Number(e.target.value))}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave}>Save</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

const THRESHOLD_FIELDS: { key: keyof PowerLevelThresholds; label: string }[] = [
  { key: "invite", label: "Invite" },
  { key: "kick", label: "Kick" },
  { key: "ban", label: "Ban" },
  { key: "redact", label: "Remove messages sent by others" },
  { key: "events_default", label: "Send messages" },
  { key: "state_default", label: "Change settings" },
  { key: "users_default", label: "Default power level" },
];

interface PowerLevelThresholdsEditorProps {
  details: RoomDetails;
}

/** Edits the per-action power-level thresholds (`m.room.power_levels`) — gated on `can.set_power_levels`. */
export function PowerLevelThresholdsEditor({ details }: PowerLevelThresholdsEditorProps) {
  const actions = useRoomAdminActions(details.room_id);
  const [thresholds, setThresholds] = useState<PowerLevelThresholds>(details.power_levels);

  const disabled = !details.can.set_power_levels;

  return (
    <div className="flex flex-col gap-3 p-4">
      <h3 className="text-sm font-semibold text-foreground">Power level thresholds</h3>
      {THRESHOLD_FIELDS.map(({ key, label }) => (
        <div key={key} className="flex items-center justify-between gap-2">
          <Label htmlFor={`threshold-${key}`} className="font-normal">
            {label}
          </Label>
          <Input
            id={`threshold-${key}`}
            type="number"
            className="w-24"
            disabled={disabled}
            value={thresholds[key]}
            onChange={(e) => setThresholds((prev) => ({ ...prev, [key]: Number(e.target.value) }))}
          />
        </div>
      ))}
      <Button
        size="sm"
        disabled={disabled}
        onClick={() => actions.setPowerLevelThresholds.mutate(thresholds)}
        className="self-end"
      >
        Save thresholds
      </Button>
    </div>
  );
}
