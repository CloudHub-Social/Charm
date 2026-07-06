import { useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { HistoryVisibilityKind, JoinRuleKind, RoomDetails } from "@/lib/matrix";
import { useRoomAdminActions } from "./useRoomAdminActions";

const JOIN_RULE_LABELS: Record<JoinRuleKind, string> = {
  public: "Public — anyone can join",
  invite: "Invite only",
  knock: "Knock — request to join",
  restricted: "Restricted (space members)",
  private: "Private",
};

const HISTORY_VISIBILITY_LABELS: Record<HistoryVisibilityKind, string> = {
  // Matrix's `m.room.history_visibility` semantics, not "from when invited" —
  // `shared` in particular grants a joined member the room's entire history,
  // not just what happened after they joined.
  invited: "Members, from when they were invited",
  joined: "Members, from when they joined",
  shared: "Members, including before they joined",
  world_readable: "Anyone, including people not in the room",
};

/** No allow-list editor exists yet (Day-2) — offering it here would silently produce an empty allow-list. */
const SELECTABLE_JOIN_RULES: JoinRuleKind[] = ["public", "invite", "knock", "private"];

interface PermissionGateProps {
  allowed: boolean;
  reason?: string;
  children: React.ReactNode;
}

/** Wraps a control so it's disabled-with-tooltip when the current user's power level is insufficient — the Spec 07 gating pattern reused by every mutating control in this panel. */
function PermissionGate({ allowed, reason, children }: PermissionGateProps) {
  if (allowed) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent>{reason ?? "You need a higher power level to do this"}</TooltipContent>
    </Tooltip>
  );
}

interface RoomSettingsFormProps {
  details: RoomDetails;
}

export function RoomSettingsForm({ details }: RoomSettingsFormProps) {
  const actions = useRoomAdminActions(details.room_id);
  const [name, setName] = useState(details.name ?? "");
  const [topic, setTopic] = useState(details.topic ?? "");
  const [confirmingEncryption, setConfirmingEncryption] = useState(false);

  useEffect(() => {
    setName(details.name ?? "");
  }, [details.name]);

  useEffect(() => {
    setTopic(details.topic ?? "");
  }, [details.topic]);

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="room-name">Room name</Label>
        <div className="flex gap-2">
          <PermissionGate allowed={details.can.set_name}>
            <Input
              id="room-name"
              value={name}
              disabled={!details.can.set_name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1"
            />
          </PermissionGate>
          <PermissionGate allowed={details.can.set_name}>
            <Button
              size="sm"
              disabled={!details.can.set_name || name === (details.name ?? "")}
              onClick={() => actions.setName.mutate(name)}
            >
              Save
            </Button>
          </PermissionGate>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="room-topic">Topic</Label>
        <div className="flex gap-2">
          <PermissionGate allowed={details.can.set_topic}>
            <textarea
              id="room-topic"
              value={topic}
              disabled={!details.can.set_topic}
              onChange={(e) => setTopic(e.target.value)}
              rows={3}
              className={cn(
                "h-9 min-h-16 w-full flex-1 rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-xs outline-none",
                "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
                "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
              )}
            />
          </PermissionGate>
          <PermissionGate allowed={details.can.set_topic}>
            <Button
              size="sm"
              disabled={!details.can.set_topic || topic === (details.topic ?? "")}
              onClick={() => actions.setTopic.mutate(topic)}
            >
              Save
            </Button>
          </PermissionGate>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Avatar</Label>
        <PermissionGate allowed={details.can.set_avatar}>
          <Button
            size="sm"
            variant="secondary"
            disabled={!details.can.set_avatar}
            onClick={async () => {
              const selected = await openFileDialog({
                multiple: false,
                filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
              });
              if (typeof selected === "string") {
                actions.setAvatar.mutate(selected);
              }
            }}
          >
            Upload new avatar
          </Button>
        </PermissionGate>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Join rule</Label>
        <PermissionGate allowed={details.can.set_join_rules}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={!details.can.set_join_rules}>
                {JOIN_RULE_LABELS[details.join_rule]}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuRadioGroup
                value={details.join_rule}
                onValueChange={(value) => actions.setJoinRule.mutate(value as JoinRuleKind)}
              >
                {SELECTABLE_JOIN_RULES.map((rule) => (
                  <DropdownMenuRadioItem key={rule} value={rule}>
                    {JOIN_RULE_LABELS[rule]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </PermissionGate>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Who can read history</Label>
        <PermissionGate allowed={details.can.set_history_visibility}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={!details.can.set_history_visibility}>
                {HISTORY_VISIBILITY_LABELS[details.history_visibility]}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuRadioGroup
                value={details.history_visibility}
                onValueChange={(value) =>
                  actions.setHistoryVisibility.mutate(value as HistoryVisibilityKind)
                }
              >
                {(Object.keys(HISTORY_VISIBILITY_LABELS) as HistoryVisibilityKind[]).map(
                  (visibility) => (
                    <DropdownMenuRadioItem key={visibility} value={visibility}>
                      {HISTORY_VISIBILITY_LABELS[visibility]}
                    </DropdownMenuRadioItem>
                  ),
                )}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </PermissionGate>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Encryption</Label>
        {details.is_encrypted ? (
          <span className="text-sm text-muted-foreground">Encrypted — this can't be undone</span>
        ) : (
          <PermissionGate allowed={details.can.set_encryption}>
            <Button
              size="sm"
              variant="destructive"
              disabled={!details.can.set_encryption}
              onClick={() => setConfirmingEncryption(true)}
            >
              Enable encryption
            </Button>
          </PermissionGate>
        )}
        <Dialog open={confirmingEncryption} onOpenChange={setConfirmingEncryption}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Enable encryption?</DialogTitle>
              <DialogDescription>
                This can't be undone — once a room is encrypted, it can never be made unencrypted
                again.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmingEncryption(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  actions.enableEncryption.mutate(undefined);
                  setConfirmingEncryption(false);
                }}
              >
                Enable encryption
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
