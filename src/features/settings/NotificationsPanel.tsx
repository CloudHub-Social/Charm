import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { requestPermission } from "@tauri-apps/plugin-notification";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  listRooms,
  type PusherKind,
  type RoomNotificationModeKind,
  type RoomSummary,
} from "@/lib/matrix";
import { usePush } from "@/features/push/usePush";
import { SettingsCard, SettingTile } from "./components/SettingsCard";
import { useNotificationSettings, useNotificationSettingsActions } from "./useNotificationSettings";

const TRANSPORT_LABELS: Record<PusherKind, string> = {
  unified_push: "UnifiedPush",
  fcm: "Firebase Cloud Messaging",
  apns: "Apple Push Notification service",
  none: "Not registered yet",
};

function PushTransportTile() {
  const { status, register, unregister } = usePush();
  const transport = status?.transport ?? "none";
  const pushError = status?.last_error?.toLowerCase() ?? "";
  const pushRegistrationFailed = pushError.includes("unifiedpush") || pushError.includes("fcm");
  const showAndroidDistributorNotice =
    status?.available === true &&
    transport === "none" &&
    !status.endpoint_present &&
    pushRegistrationFailed;

  // The homeserver can only deliver a push if the OS has also granted the
  // notification permission — without this, `register_push` can succeed
  // while `app.notification().show()` still silently shows nothing (Android
  // 13+/iOS both gate on it separately from push registration itself). Only
  // proceed to register if the user actually granted it — registering a
  // pusher the OS won't let us show anything for just generates server
  // traffic with no visible result until they separately fix permissions.
  async function handleEnable() {
    const permission = await requestPermission();
    if (permission !== "granted") return;
    register.mutate();
  }

  return (
    <SettingTile
      title="Push notifications"
      description={
        !status?.available ? (
          "Not available on this platform — desktop relies on the always-on sync loop instead."
        ) : (
          <>
            Lets Charm notify you with a real message preview even when it's closed. Transport:{" "}
            {TRANSPORT_LABELS[transport]}.
            {showAndroidDistributorNotice && (
              <span className="mt-2 block rounded-md border border-border bg-muted/40 px-3 py-2 text-foreground">
                Android push requires a UnifiedPush distributor (for example, ntfy). Install one,
                then turn on push notifications.
              </span>
            )}
            {status?.last_error && (
              <span className="mt-1 block text-destructive">{status.last_error}</span>
            )}
          </>
        )
      }
      control={
        status?.available ? (
          status?.registered ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => unregister.mutate()}
              disabled={unregister.isPending}
            >
              Turn off push notifications
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleEnable()}
              disabled={register.isPending}
            >
              Turn on push notifications
            </Button>
          )
        ) : undefined
      }
    />
  );
}

const MODE_LABELS: Record<RoomNotificationModeKind, string> = {
  all_messages: "All messages",
  mentions_and_keywords_only: "Mentions & keywords only",
  mute: "Mute",
};

function ModePicker({
  value,
  onChange,
  disabled,
}: {
  value: RoomNotificationModeKind;
  onChange: (mode: RoomNotificationModeKind) => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          {MODE_LABELS[value]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as RoomNotificationModeKind)}
        >
          {(Object.keys(MODE_LABELS) as RoomNotificationModeKind[]).map((mode) => (
            <DropdownMenuRadioItem key={mode} value={mode}>
              {MODE_LABELS[mode]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function KeywordEditor({
  keywords,
  onAdd,
  onRemove,
}: {
  keywords: string[];
  onAdd: (keyword: string) => void;
  onRemove: (keyword: string) => void;
}) {
  const [draft, setDraft] = useState("");

  function handleAdd() {
    const trimmed = draft.trim();
    if (trimmed === "" || keywords.includes(trimmed)) return;
    onAdd(trimmed);
    setDraft("");
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-2">
        {keywords.map((keyword) => (
          <span
            key={keyword}
            className="flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-sm text-foreground"
          >
            {keyword}
            <button
              type="button"
              aria-label={`Remove keyword ${keyword}`}
              className="text-muted-foreground hover:text-foreground"
              onClick={() => onRemove(keyword)}
            >
              ×
            </button>
          </span>
        ))}
        {keywords.length === 0 && (
          <span className="text-sm text-muted-foreground">No keyword alerts yet.</span>
        )}
      </div>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder="Add a keyword"
          aria-label="Add a keyword"
        />
        <Button variant="outline" onClick={handleAdd} disabled={draft.trim() === ""}>
          Add
        </Button>
      </div>
    </div>
  );
}

function RoomModeRow({
  room,
  onChangeMode,
  disabled,
}: {
  room: RoomSummary;
  onChangeMode: (roomId: string, mode: RoomNotificationModeKind) => void;
  disabled?: boolean;
}) {
  const currentMode: RoomNotificationModeKind = room.notification_mode ?? "all_messages";

  return (
    <SettingTile
      title={room.name ?? room.room_id}
      control={
        <ModePicker
          value={currentMode}
          onChange={(mode) => onChangeMode(room.room_id, mode)}
          disabled={disabled}
        />
      }
    />
  );
}

export function NotificationsPanel() {
  const { data: settings } = useNotificationSettings();
  const { setDefaultMode, addKeyword, removeKeyword, setMute, setSound, setRoomMode } =
    useNotificationSettingsActions();
  const { data: rooms } = useQuery({
    queryKey: ["rooms", "notifications-panel"],
    queryFn: listRooms,
  });
  const joinedRooms = (rooms ?? []).filter((room) => room.membership === "join");

  return (
    <div className="max-w-lg space-y-6">
      <h1 className="text-lg font-bold text-foreground">Notifications</h1>

      <SettingsCard>
        <PushTransportTile />
        <SettingTile
          title="Default notification mode"
          description="Applies to any room without its own override below."
          control={
            settings && (
              <ModePicker
                value={settings.default_mode}
                onChange={(mode) => setDefaultMode.mutate(mode)}
                disabled={setDefaultMode.isPending}
              />
            )
          }
        />
        <SettingTile
          title="Do not disturb"
          description="Overrides the default mode above with Mute while on. Turning it off restores your previous default. This device must be online for the override to apply."
          control={
            <input
              type="checkbox"
              aria-label="Mute all rooms"
              checked={settings?.global_mute ?? false}
              onChange={(e) => setMute.mutate(e.target.checked)}
              disabled={setMute.isPending}
            />
          }
        />
        <SettingTile
          title="Sound"
          description="Playback depends on push delivery, which isn't wired up yet — this only stores your preference for when it is."
          control={
            <input
              type="checkbox"
              aria-label="Play a sound for notifications"
              checked={settings?.sound_enabled ?? true}
              onChange={(e) => setSound.mutate(e.target.checked)}
              disabled={setSound.isPending}
            />
          }
        />
      </SettingsCard>

      <SettingsCard heading="Keyword alerts">
        <SettingTile>
          <KeywordEditor
            keywords={settings?.keywords ?? []}
            onAdd={(keyword) => addKeyword.mutate(keyword)}
            onRemove={(keyword) => removeKeyword.mutate(keyword)}
          />
        </SettingTile>
      </SettingsCard>

      <SettingsCard heading="Per-room overrides">
        {joinedRooms.map((room) => (
          <RoomModeRow
            key={room.room_id}
            room={room}
            onChangeMode={(roomId, mode) => setRoomMode.mutate({ roomId, mode })}
            disabled={setRoomMode.isPending}
          />
        ))}
        {joinedRooms.length === 0 && (
          <SettingTile title={<span className="text-muted-foreground">No rooms yet.</span>} />
        )}
      </SettingsCard>
    </div>
  );
}
