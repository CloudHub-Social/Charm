import { useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { createSpace, joinRoom } from "@/lib/matrix";

interface CreateJoinSpaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSpaceCreated: (spaceId: string) => void;
  onSpaceJoined: (spaceId: string) => void;
}

/**
 * Discoverable entry point for Spec 19 Phase 4: create a new space, or join
 * one by address/room ID. Triggered from the `+` button at the bottom of
 * `SpaceRail`. Adding an existing room *to* a space, and any public-space
 * directory/"explore" browsing, are separate follow-ups — this only covers
 * the phase's stated acceptance criterion (create + join-by-address).
 */
export function CreateJoinSpaceDialog({
  open,
  onOpenChange,
  onSpaceCreated,
  onSpaceJoined,
}: CreateJoinSpaceDialogProps) {
  const [tab, setTab] = useState<"create" | "join">("create");
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [roomAlias, setRoomAlias] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [joinTarget, setJoinTarget] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Identifies the current in-flight create/join request, if any, so a
  // callback can tell "am I still the request the dialog cares about" apart
  // from "some request is active" — a plain boolean can't distinguish a
  // dismissed-then-superseded request from the new one the user just
  // started, since both would see the flag as "active" and a stale response
  // could silently win the race. Bumped on both dismiss (invalidates
  // whatever was in flight) and every new request (claims a fresh id); a
  // response only proceeds if the id it captured is still current.
  const requestIdRef = useRef(0);

  function resetAndClose() {
    requestIdRef.current += 1;
    setTab("create");
    setName("");
    setTopic("");
    setRoomAlias("");
    setIsPublic(false);
    setJoinTarget("");
    setError(null);
    setPending(false);
    onOpenChange(false);
  }

  async function handleCreate() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    setPending(true);
    setError(null);
    const requestId = ++requestIdRef.current;
    try {
      const spaceId = await createSpace(
        trimmedName,
        topic.trim() || undefined,
        roomAlias.trim() || undefined,
        isPublic,
      );
      if (requestIdRef.current !== requestId) return;
      onSpaceCreated(spaceId);
      resetAndClose();
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setError(err instanceof Error ? err.message : "Couldn't create the space.");
      setPending(false);
    }
  }

  async function handleJoin() {
    const trimmedTarget = joinTarget.trim();
    if (!trimmedTarget) {
      setError("Enter a space address or ID.");
      return;
    }
    // A bare room ID (`!id:server`) has no via-server list attached, and
    // Matrix federation generally can't route a join to a room the local
    // homeserver doesn't already know about without one — unlike an alias,
    // which resolves via its own server's directory. Rather than silently
    // fail for a pasted permalink-style ID from a remote/unknown room,
    // require an alias here.
    if (trimmedTarget.startsWith("!")) {
      setError("Enter a space address (e.g. #space:example.org), not a room ID.");
      return;
    }
    setPending(true);
    setError(null);
    const requestId = ++requestIdRef.current;
    try {
      const joined = await joinRoom(trimmedTarget);
      if (requestIdRef.current !== requestId) return;
      if (!joined.is_space) {
        setError("That address is a room, not a space.");
        setPending(false);
        return;
      }
      onSpaceJoined(joined.room_id);
      resetAndClose();
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setError(err instanceof Error ? err.message : "Couldn't join that space.");
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : resetAndClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create or join a space</DialogTitle>
        </DialogHeader>
        <Tabs
          value={tab}
          onValueChange={(value) => {
            setTab(value as "create" | "join");
            setError(null);
          }}
        >
          <TabsList className="w-full">
            <TabsTrigger value="create">Create new</TabsTrigger>
            <TabsTrigger value="join">Join by address</TabsTrigger>
          </TabsList>
          <TabsContent value="create" className="flex flex-col gap-3 pt-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="space-name">Name</Label>
              <Input
                id="space-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Space name"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="space-topic">Topic (optional)</Label>
              <Input
                id="space-topic"
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
                placeholder="What's this space for?"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="space-alias">Address (optional)</Label>
              <Input
                id="space-alias"
                value={roomAlias}
                onChange={(event) => setRoomAlias(event.target.value)}
                placeholder="engineering"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                className="size-3.5 accent-primary"
                checked={isPublic}
                onChange={(event) => setIsPublic(event.target.checked)}
              />
              Public space
            </label>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button onClick={handleCreate} disabled={pending}>
              {pending ? "Creating…" : "Create space"}
            </Button>
          </TabsContent>
          <TabsContent value="join" className="flex flex-col gap-3 pt-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="space-join-target">Space address</Label>
              <Input
                id="space-join-target"
                value={joinTarget}
                onChange={(event) => setJoinTarget(event.target.value)}
                placeholder="#space:example.org"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button onClick={handleJoin} disabled={pending}>
              {pending ? "Joining…" : "Join space"}
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
