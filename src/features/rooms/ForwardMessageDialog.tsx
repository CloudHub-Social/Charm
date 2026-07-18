import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { forwardMessage, listRooms } from "@/lib/matrix";
import { avatarColor, initials, resolveAvatar } from "./roomDisplay";

const ROOMS_QUERY_KEY = ["forward-message-rooms"] as const;

interface ForwardMessageDialogProps {
  open: boolean;
  sourceRoomId: string | null;
  eventId: string | null;
  onOpenChange: (open: boolean) => void;
  onForwarded?: () => void;
}

/** Room picker for forwarding a message into another joined room. */
export function ForwardMessageDialog({
  open,
  sourceRoomId,
  eventId,
  onOpenChange,
  onForwarded,
}: ForwardMessageDialogProps) {
  const [filter, setFilter] = useState("");
  const [submittingRoomId, setSubmittingRoomId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: rooms, isLoading } = useQuery({
    queryKey: ROOMS_QUERY_KEY,
    queryFn: listRooms,
    enabled: open,
  });

  const filteredRooms = useMemo(() => {
    if (!rooms) return [];
    const needle = filter.trim().toLowerCase();
    if (needle === "") return rooms;
    return rooms.filter((room) => (room.name ?? room.room_id).toLowerCase().includes(needle));
  }, [rooms, filter]);

  async function handleForward(targetRoomId: string) {
    if (!sourceRoomId || !eventId) return;
    setSubmittingRoomId(targetRoomId);
    setError(null);
    try {
      await forwardMessage(sourceRoomId, eventId, targetRoomId);
      setSubmittingRoomId(null);
      setFilter("");
      onOpenChange(false);
      onForwarded?.();
    } catch (err) {
      setSubmittingRoomId(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setFilter("");
          setError(null);
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Forward message</DialogTitle>
          <DialogDescription>Choose a room to forward this message to.</DialogDescription>
        </DialogHeader>
        <Input
          placeholder="Filter rooms…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        {error && (
          <p role="alert" className="text-sm text-destructive-foreground">
            Could not forward the message: {error}
          </p>
        )}
        {isLoading && <p className="text-sm text-muted-foreground">Loading rooms…</p>}
        <ul className="flex max-h-80 flex-col gap-1 overflow-auto">
          {filteredRooms.map((room) => (
            <li key={room.room_id}>
              <button
                type="button"
                onClick={() => void handleForward(room.room_id)}
                disabled={submittingRoomId !== null}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary disabled:pointer-events-none disabled:opacity-40"
              >
                <Avatar size="sm">
                  <AvatarImage src={resolveAvatar(room.avatar_path, room.avatar_url)} alt="" />
                  <AvatarFallback
                    style={{ background: avatarColor(room.room_id) }}
                    className="font-bold text-white"
                  >
                    {initials(room.room_id, room.name)}
                  </AvatarFallback>
                </Avatar>
                <span className="truncate">{room.name ?? room.room_id}</span>
                {submittingRoomId === room.room_id && (
                  <span className="ml-auto text-xs text-muted-foreground">Forwarding…</span>
                )}
              </button>
            </li>
          ))}
          {!isLoading && filteredRooms.length === 0 && (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">No rooms match.</li>
          )}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
