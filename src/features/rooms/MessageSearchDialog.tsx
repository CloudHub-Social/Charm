import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  searchMessages,
  type RoomSummary,
  type SearchResult,
  type SearchResultPage,
} from "@/lib/matrix";
import { displayName } from "./roomDisplay";

interface MessageSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rooms: RoomSummary[];
  activeRoomId: string | null;
  onSelectResult: (result: SearchResult) => void;
}

export function MessageSearchDialog({
  open,
  onOpenChange,
  rooms,
  activeRoomId,
  onSelectResult,
}: MessageSearchDialogProps) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"room" | "all">(activeRoomId ? "room" : "all");
  const [page, setPage] = useState<SearchResultPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingResult, setPendingResult] = useState<SearchResult | null>(null);
  const requestId = useRef(0);
  const queryInput = useRef<HTMLInputElement>(null);
  const jumpDisclosureAcknowledged = useRef(false);
  const roomNames = useMemo(
    () => new Map(rooms.map((room) => [room.room_id, displayName(room.room_id, room.name)])),
    [rooms],
  );

  useEffect(() => {
    if (!open) return;
    setScope(activeRoomId ? "room" : "all");
    setPage(null);
    setError(null);
    setPendingResult(null);
    queryInput.current?.focus();
  }, [open, activeRoomId]);

  function navigateToResult(result: SearchResult) {
    onSelectResult(result);
    onOpenChange(false);
  }

  function requestResultNavigation(result: SearchResult) {
    if (jumpDisclosureAcknowledged.current) {
      navigateToResult(result);
      return;
    }
    setPendingResult(result);
  }

  async function runSearch(cursor: string | null = null) {
    const normalized = query.trim();
    if (!normalized) return;
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const next = await searchMessages(
        normalized,
        scope === "room" ? activeRoomId : null,
        30,
        cursor,
      );
      if (id !== requestId.current) return;
      setPage((current) =>
        cursor && current ? { ...next, results: [...current.results, ...next.results] } : next,
      );
    } catch (caught) {
      if (id === requestId.current) {
        const code =
          caught && typeof caught === "object"
            ? "code" in caught && typeof caught.code === "string"
              ? caught.code
              : "kind" in caught && typeof caught.kind === "string"
                ? caught.kind
                : null
            : null;
        setError(
          code === "stale_cursor"
            ? "Search results expired. Run the search again."
            : "Message search is temporarily unavailable.",
        );
      }
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void runSearch();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(42rem,90vh)] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>Search messages</DialogTitle>
          <DialogDescription>
            Searches decrypted messages stored in this account’s encrypted local index.
          </DialogDescription>
        </DialogHeader>
        <form className="flex gap-2" onSubmit={submit}>
          <div className="relative min-w-0 flex-1">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={queryInput}
              type="search"
              aria-label="Message search query"
              value={query}
              maxLength={512}
              onChange={(event) => setQuery(event.target.value)}
              className="pl-9"
            />
          </div>
          <Button type="submit" disabled={loading || !query.trim()}>
            Search
          </Button>
        </form>
        <fieldset className="flex gap-4 text-sm">
          <legend className="sr-only">Search scope</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="message-search-scope"
              checked={scope === "room"}
              disabled={!activeRoomId}
              onChange={() => setScope("room")}
            />
            This room
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="message-search-scope"
              checked={scope === "all"}
              onChange={() => setScope("all")}
            />
            All rooms
          </label>
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {page?.incomplete && (
          <output className="text-sm text-muted-foreground">
            Results may be incomplete while the local index catches up.
          </output>
        )}
        {pendingResult && (
          <section
            role="alert"
            aria-labelledby="message-search-jump-disclosure-title"
            className="rounded-md border bg-muted/40 p-3 text-sm"
          >
            <h3 id="message-search-jump-disclosure-title" className="font-medium">
              Opening this result may contact your homeserver
            </h3>
            <p className="mt-1 text-muted-foreground">
              If the message is not already loaded, Charm asks your homeserver for context around
              it, which reveals the event ID.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setPendingResult(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => {
                  jumpDisclosureAcknowledged.current = true;
                  navigateToResult(pendingResult);
                  setPendingResult(null);
                }}
              >
                Open message
              </Button>
            </div>
          </section>
        )}
        <div className="min-h-24 flex-1 overflow-y-auto" aria-live="polite">
          {page && page.results.length === 0 && !loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No messages found.</p>
          ) : (
            <ul className="space-y-1">
              {page?.results.map((result) => (
                <li key={`${result.room_id}:${result.event_id}`}>
                  <button
                    type="button"
                    className="w-full rounded-md px-3 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => requestResultNavigation(result)}
                  >
                    <span className="block text-xs text-muted-foreground">
                      {roomNames.get(result.room_id) ?? result.room_id} · {result.sender} ·{" "}
                      {new Date(result.origin_server_ts).toLocaleString()}
                    </span>
                    <HighlightedSnippet result={result} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {page?.next_cursor && (
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => void runSearch(page.next_cursor)}
          >
            {loading ? "Loading…" : "Load more"}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}

function HighlightedSnippet({ result }: { result: SearchResult }) {
  const range = result.match_ranges[0];
  if (!range || range.start >= range.end || range.end > result.snippet.length) {
    return <span className="mt-1 block text-sm text-foreground">{result.snippet}</span>;
  }
  return (
    <span className="mt-1 block text-sm text-foreground">
      {result.snippet.slice(0, range.start)}
      <mark>{result.snippet.slice(range.start, range.end)}</mark>
      {result.snippet.slice(range.end)}
    </span>
  );
}
