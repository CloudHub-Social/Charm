import { useState } from "react";
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
  const [isPublic, setIsPublic] = useState(false);
  const [joinTarget, setJoinTarget] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetAndClose() {
    setName("");
    setTopic("");
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
    try {
      const spaceId = await createSpace(
        trimmedName,
        topic.trim() || undefined,
        undefined,
        isPublic,
      );
      onSpaceCreated(spaceId);
      resetAndClose();
    } catch (err) {
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
    setPending(true);
    setError(null);
    try {
      const spaceId = await joinRoom(trimmedTarget);
      onSpaceJoined(spaceId);
      resetAndClose();
    } catch (err) {
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
        <Tabs value={tab} onValueChange={(value) => setTab(value as "create" | "join")}>
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
              <Label htmlFor="space-join-target">Space address or ID</Label>
              <Input
                id="space-join-target"
                value={joinTarget}
                onChange={(event) => setJoinTarget(event.target.value)}
                placeholder="#space:example.org or !id:example.org"
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
