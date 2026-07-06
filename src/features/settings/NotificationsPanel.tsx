import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { listRooms, type RoomNotificationModeKind, type RoomSummary } from "@/lib/matrix";
import { useNotificationSettings, useNotificationSettingsActions } from "./useNotificationSettings";

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
    <div className="flex items-center justify-between py-2">
      <span className="truncate text-sm text-foreground">{room.name ?? room.room_id}</span>
      <ModePicker
        value={currentMode}
        onChange={(mode) => onChangeMode(room.room_id, mode)}
        disabled={disabled}
      />
    </div>
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

  return (
    <div className="max-w-lg space-y-8">
      <section>
        <h2 className="mb-2 text-lg font-bold text-foreground">Default notification mode</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Applies to any room without its own override below.
        </p>
        {settings && (
          <ModePicker
            value={settings.default_mode}
            onChange={(mode) => setDefaultMode.mutate(mode)}
            disabled={setDefaultMode.isPending}
          />
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-bold text-foreground">Do not disturb</h2>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={settings?.global_mute ?? false}
              onChange={(e) => setMute.mutate(e.target.checked)}
              disabled={setMute.isPending}
            />
            Mute all rooms
          </label>
        </div>
        <p className="text-sm text-muted-foreground">
          Overrides the default mode above with Mute while on. Turning it off restores your previous
          default. This device must be online for the override to apply.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-bold text-foreground">Keyword alerts</h2>
        <KeywordEditor
          keywords={settings?.keywords ?? []}
          onAdd={(keyword) => addKeyword.mutate(keyword)}
          onRemove={(keyword) => removeKeyword.mutate(keyword)}
        />
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-foreground">Sound</h2>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={settings?.sound_enabled ?? true}
              onChange={(e) => setSound.mutate(e.target.checked)}
              disabled={setSound.isPending}
            />
            Play a sound for notifications
          </label>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Playback depends on push delivery, which isn't wired up yet — this only stores your
          preference for when it is.
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-bold text-foreground">Per-room overrides</h2>
        <div className="divide-y divide-border">
          {(rooms ?? []).map((room) => (
            <RoomModeRow
              key={room.room_id}
              room={room}
              onChangeMode={(roomId, mode) => setRoomMode.mutate({ roomId, mode })}
              disabled={setRoomMode.isPending}
            />
          ))}
          {rooms?.length === 0 && <p className="text-sm text-muted-foreground">No rooms yet.</p>}
        </div>
      </section>
    </div>
  );
}
