import Fuse from "fuse.js";
import * as Sentry from "@sentry/react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { SearchIcon } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { RoomSummary } from "@/lib/matrix";
import { cn } from "@/lib/utils";
import { avatarColor, displayName, initials, resolveAvatar } from "./roomDisplay";
import {
  readQuickSwitcherRecents,
  reconcileQuickSwitcherRecents,
  recordQuickSwitcherRecent,
} from "./quickSwitcherRecents";

/* oxlint-disable jsx-a11y/prefer-tag-over-role -- ARIA combobox/listbox patterns intentionally use a text input and interactive result buttons; native select/datalist cannot provide the required fuzzy result UI. */

const PAGE_SIZE = 5;

interface SwitcherEntry {
  room: RoomSummary;
  name: string;
  peer: string;
  parentNames: string[];
}

interface QuickSwitcherDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rooms: RoomSummary[];
  roomsLoaded: boolean;
  currentUserId: string;
  onSelectRoom: (room: RoomSummary) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}

export function QuickSwitcherDialog({
  open,
  onOpenChange,
  rooms,
  roomsLoaded,
  currentUserId,
  onSelectRoom,
  returnFocusRef,
}: QuickSwitcherDialogProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentState, setRecentState] = useState(() => ({
    accountId: currentUserId,
    roomIds: readQuickSwitcherRecents(currentUserId),
  }));
  const inputRef = useRef<HTMLInputElement>(null);
  const activeOptionRef = useRef<HTMLButtonElement>(null);
  const entries = useMemo(() => buildEntries(rooms), [rooms]);
  const validRoomIds = useMemo(
    () => new Set(entries.map((entry) => entry.room.room_id)),
    [entries],
  );
  const recentRoomIds =
    recentState.accountId === currentUserId
      ? recentState.roomIds.filter((roomId) => validRoomIds.has(roomId))
      : readQuickSwitcherRecents(currentUserId).filter((roomId) => validRoomIds.has(roomId));
  const fuse = useMemo(
    () =>
      new Fuse(entries, {
        includeScore: true,
        ignoreLocation: true,
        threshold: 0.35,
        keys: [
          { name: "name", weight: 0.7 },
          { name: "peer", weight: 0.2 },
          { name: "parentNames", weight: 0.1 },
        ],
      }),
    [entries],
  );
  const results = useMemo(
    () =>
      query.trim()
        ? fuse.search(query.trim()).map((result) => result.item)
        : orderEmptyQuery(entries, recentRoomIds),
    [entries, fuse, query, recentRoomIds],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
  }, [open, currentUserId]);

  useEffect(() => {
    if (!open || !roomsLoaded) return;
    const roomIds = reconcileQuickSwitcherRecents(currentUserId, validRoomIds);
    setRecentState({ accountId: currentUserId, roomIds });
  }, [open, roomsLoaded, currentUserId, validRoomIds]);

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, results.length - 1)));
  }, [results.length]);

  useEffect(() => {
    activeOptionRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, results]);

  function choose(entry: SwitcherEntry) {
    // Every entry is resolved from the current joined-room snapshot, so this
    // canonical navigation call is the success boundary for recording it.
    onSelectRoom(entry.room);
    Sentry.addBreadcrumb({
      category: "navigation.quick-switcher",
      level: "info",
      message: "Selected a quick switcher result",
      data: { result_kind: entryKind(entry.room) },
    });
    const roomIds = recordQuickSwitcherRecent(currentUserId, entry.room.room_id);
    setRecentState({ accountId: currentUserId, roomIds });
    onOpenChange(false);
  }

  function moveSelection(nextIndex: number) {
    if (results.length === 0) return;
    setActiveIndex(Math.max(0, Math.min(results.length - 1, nextIndex)));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(38rem,90vh)] max-w-xl flex-col gap-3 p-4"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Quick switcher</DialogTitle>
          <DialogDescription>Jump to a joined room, direct message, or space.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            ref={inputRef}
            role="combobox"
            aria-label="Search rooms, direct messages, and spaces"
            aria-controls="quick-switcher-results"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-activedescendant={
              results[activeIndex] ? optionId(results[activeIndex]) : undefined
            }
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveSelection(activeIndex + 1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveSelection(activeIndex - 1);
              } else if (event.key === "Home") {
                event.preventDefault();
                moveSelection(0);
              } else if (event.key === "End") {
                event.preventDefault();
                moveSelection(results.length - 1);
              } else if (event.key === "PageDown") {
                event.preventDefault();
                moveSelection(activeIndex + PAGE_SIZE);
              } else if (event.key === "PageUp") {
                event.preventDefault();
                moveSelection(activeIndex - PAGE_SIZE);
              } else if (event.key === "Enter" && results[activeIndex]) {
                event.preventDefault();
                choose(results[activeIndex]);
              }
            }}
            placeholder="Jump to a room or space"
            className="h-11 pr-10 pl-10"
          />
          <kbd className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            Esc
          </kbd>
        </div>
        <p className="sr-only" aria-live="polite">
          {results.length} {results.length === 1 ? "result" : "results"} available.
        </p>
        <div id="quick-switcher-results" role="listbox" className="min-h-24 overflow-y-auto">
          {results.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No rooms found.</p>
          ) : (
            <div className="space-y-1">
              {results.map((entry, index) => (
                <button
                  key={entry.room.room_id}
                  ref={index === activeIndex ? activeOptionRef : undefined}
                  id={optionId(entry)}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === activeIndex}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => choose(entry)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left",
                    index === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted",
                  )}
                >
                  <Avatar size="sm">
                    <AvatarImage
                      src={resolveAvatar(entry.room.avatar_path, entry.room.avatar_url)}
                      alt=""
                    />
                    <AvatarFallback
                      style={{ background: avatarColor(entry.room.room_id) }}
                      className="font-bold text-white"
                    >
                      {initials(entry.room.room_id, entry.room.name)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{entry.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {entryContext(entry)}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">{entryKind(entry.room)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function buildEntries(rooms: RoomSummary[]): SwitcherEntry[] {
  const joinedById = new Map(
    rooms.filter((room) => room.membership === "join").map((room) => [room.room_id, room]),
  );
  return [...joinedById.values()].map((room) => ({
    room,
    name: displayName(room.room_id, room.name),
    peer: room.dm_peer_user_id ?? "",
    parentNames: room.parent_space_ids
      .map((parentId) => joinedById.get(parentId))
      .filter((parent): parent is RoomSummary => parent?.is_space === true)
      .map((parent) => displayName(parent.room_id, parent.name)),
  }));
}

function orderEmptyQuery(entries: SwitcherEntry[], recentRoomIds: string[]): SwitcherEntry[] {
  const byId = new Map(entries.map((entry) => [entry.room.room_id, entry]));
  const recent = recentRoomIds.flatMap((roomId) => {
    const entry = byId.get(roomId);
    return entry ? [entry] : [];
  });
  const recentIds = new Set(recent.map((entry) => entry.room.room_id));
  const remaining = entries.filter((entry) => !recentIds.has(entry.room.room_id));
  return [
    ...recent,
    ...remaining.filter((entry) => entry.room.is_space),
    ...remaining.filter((entry) => entry.room.is_direct && !entry.room.is_space),
    ...remaining.filter((entry) => !entry.room.is_space && !entry.room.is_direct),
  ];
}

function entryKind(room: RoomSummary): string {
  return room.is_space ? "Space" : room.is_direct ? "DM" : "Room";
}

function entryContext(entry: SwitcherEntry): string {
  if (entry.room.is_direct && entry.peer) return entry.peer;
  if (entry.parentNames.length > 0) return entry.parentNames.join(" · ");
  return entry.room.is_space ? "Space" : "Home";
}

function optionId(entry: SwitcherEntry): string {
  return `quick-switcher-${encodeURIComponent(entry.room.room_id)}`;
}
