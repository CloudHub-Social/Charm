import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
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
  // Bumped whenever the dialog closes, reopens, or targets a different
  // message — same request-sequence pattern the source/history dialogs use.
  // Without it, a forward still in flight when any of that happens can land
  // its success/failure state (closing the dialog, showing an error) on a
  // dialog instance the user has since closed, reopened, or repointed at a
  // different message.
  const requestGenerationRef = useRef(0);
  useEffect(() => {
    requestGenerationRef.current += 1;
  }, [open, sourceRoomId, eventId]);

  const { data: rooms, isLoading } = useQuery({
    queryKey: ROOMS_QUERY_KEY,
    queryFn: listRooms,
    enabled: open,
  });

  const filteredRooms = useMemo(() => {
    if (!rooms) return [];
    // Only joined rooms are valid forward targets — `list_rooms` also
    // returns pending invites (`membership: "invite"`), and forwarding into
    // one would fail with an avoidable IPC error since the account hasn't
    // actually joined it yet.
    const joinedRooms = rooms.filter(
      (room) => room.membership === "join" && !room.is_space && room.room_id !== sourceRoomId,
    );
    const needle = filter.trim().toLowerCase();
    if (needle === "") return joinedRooms;
    return joinedRooms.filter((room) => (room.name ?? room.room_id).toLowerCase().includes(needle));
  }, [rooms, filter, sourceRoomId]);

  async function handleForward(targetRoomId: string) {
    if (!sourceRoomId || !eventId) return;
    const generation = requestGenerationRef.current;
    setSubmittingRoomId(targetRoomId);
    setError(null);
    try {
      await forwardMessage(sourceRoomId, eventId, targetRoomId);
      // The dialog closed/reopened/retargeted while this was in flight —
      // applying success state now would act on a stale request.
      if (requestGenerationRef.current !== generation) return;
      setSubmittingRoomId(null);
      setFilter("");
      onOpenChange(false);
      onForwarded?.();
    } catch (err) {
      if (requestGenerationRef.current !== generation) return;
      setSubmittingRoomId(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Shared by the Dialog's own onOpenChange(false) (Escape key, overlay
  // click) and the Cancel button below, which previously called the parent
  // `onOpenChange` prop directly — bypassing these resets entirely, so
  // closing via Cancel specifically left stale filter/error/submitting
  // state for the next open.
  function close() {
    setFilter("");
    setError(null);
    // Otherwise a forward still in flight when the dialog is closed leaves
    // every room button disabled (`disabled={submittingRoomId !== null}`)
    // the next time it's reopened, until that original request happens to
    // settle.
    setSubmittingRoomId(null);
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          close();
          return;
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
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
