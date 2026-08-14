import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Search } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  joinRoom,
  resolveAvatar as resolveAvatarMxc,
  searchPublicRooms,
  type PublicRoomSummary,
} from "@/lib/matrix";
import { isWebBuild } from "@/lib/platform";
import { avatarColor, initials, resolveAvatar } from "./roomDisplay";

const SEARCH_DEBOUNCE_MS = 300;

function DirectoryRoomAvatar({ room }: { room: PublicRoomSummary }) {
  const [desktopPath, setDesktopPath] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setDesktopPath(null);
    if (!room.avatar_url || isWebBuild()) return () => undefined;

    void resolveAvatarMxc(room.avatar_url).then((path) => {
      if (current) setDesktopPath(path);
    });
    return () => {
      current = false;
    };
  }, [room.avatar_url]);

  const label = room.name ?? room.canonical_alias ?? room.room_id;
  return (
    <Avatar className="size-10 shrink-0">
      <AvatarImage src={resolveAvatar(desktopPath, room.avatar_url)} alt="" />
      <AvatarFallback style={{ backgroundColor: avatarColor(room.room_id) }} className="text-white">
        {initials(room.room_id, label)}
      </AvatarFallback>
    </Avatar>
  );
}

interface RoomDirectoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onJoined: (roomId: string) => void;
}

export function RoomDirectoryDialog({ open, onOpenChange, onJoined }: RoomDirectoryDialogProps) {
  const [query, setQuery] = useState("");
  const [rooms, setRooms] = useState<PublicRoomSummary[]>([]);
  const [nextBatch, setNextBatch] = useState<string | null>(null);
  const [totalEstimate, setTotalEstimate] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchRequestIdRef = useRef(0);

  useEffect(() => {
    if (!open) {
      searchRequestIdRef.current += 1;
      return;
    }

    const requestId = ++searchRequestIdRef.current;
    const timeout = window.setTimeout(
      () => {
        setLoading(true);
        setError(null);
        void searchPublicRooms(query.trim() || null)
          .then((page) => {
            if (searchRequestIdRef.current !== requestId) return;
            setRooms(page.rooms);
            setNextBatch(page.next_batch);
            setTotalEstimate(page.total_room_count_estimate);
          })
          .catch((reason: unknown) => {
            if (searchRequestIdRef.current !== requestId) return;
            setRooms([]);
            setNextBatch(null);
            setTotalEstimate(null);
            setError(reason instanceof Error ? reason.message : "Couldn't load public rooms.");
          })
          .finally(() => {
            if (searchRequestIdRef.current === requestId) setLoading(false);
          });
      },
      query.trim() ? SEARCH_DEBOUNCE_MS : 0,
    );

    return () => window.clearTimeout(timeout);
  }, [open, query]);

  async function loadMore() {
    if (!nextBatch || loadingMore) return;
    const requestId = ++searchRequestIdRef.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await searchPublicRooms(query.trim() || null, nextBatch);
      if (searchRequestIdRef.current !== requestId) return;
      setRooms((current) => {
        const existing = new Set(current.map((room) => room.room_id));
        return [...current, ...page.rooms.filter((room) => !existing.has(room.room_id))];
      });
      setNextBatch(page.next_batch);
      setTotalEstimate(page.total_room_count_estimate ?? totalEstimate);
    } catch (reason) {
      if (searchRequestIdRef.current !== requestId) return;
      setError(reason instanceof Error ? reason.message : "Couldn't load more public rooms.");
    } finally {
      if (searchRequestIdRef.current === requestId) setLoadingMore(false);
    }
  }

  async function join(room: PublicRoomSummary) {
    if (joiningRoomId) return;
    setJoiningRoomId(room.room_id);
    setError(null);
    try {
      const joined = await joinRoom(room.canonical_alias ?? room.room_id);
      onJoined(joined.room_id);
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't join the room.");
    } finally {
      setJoiningRoomId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(42rem,85vh)] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Browse public rooms</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search this homeserver's directory"
            aria-label="Search public rooms"
            className="pl-9"
          />
        </div>

        {totalEstimate !== null && !loading && (
          <p className="text-xs text-muted-foreground">
            About {totalEstimate.toLocaleString()} public rooms
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="min-h-40 flex-1 overflow-y-auto rounded-lg border border-border">
          {loading ? (
            <div className="flex min-h-40 items-center justify-center text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" aria-label="Loading public rooms" />
            </div>
          ) : rooms.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {query.trim() ? "No public rooms match this search." : "No public rooms found."}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {rooms.map((room) => {
                const label = room.name ?? room.canonical_alias ?? room.room_id;
                const joining = joiningRoomId === room.room_id;
                return (
                  <li key={room.room_id} className="flex items-center gap-3 p-3">
                    <DirectoryRoomAvatar room={room} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">{label}</p>
                      {room.canonical_alias && room.canonical_alias !== label && (
                        <p className="truncate text-xs text-muted-foreground">
                          {room.canonical_alias}
                        </p>
                      )}
                      {room.topic && (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {room.topic}
                        </p>
                      )}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {room.joined_members.toLocaleString()} member
                        {room.joined_members === 1 ? "" : "s"}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={joiningRoomId !== null}
                      onClick={() => void join(room)}
                    >
                      {joining ? "Joining…" : "Join"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {nextBatch && !loading && (
          <Button variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
