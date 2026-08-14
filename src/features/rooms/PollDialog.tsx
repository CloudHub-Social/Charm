import { useEffect, useRef, useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { createPoll } from "@/lib/matrix";

interface PollDialogProps {
  open: boolean;
  roomId: string;
  onOpenChange: (open: boolean) => void;
}

const EMPTY_OPTIONS = ["", ""];

export function PollDialog({ open, roomId, onOpenChange }: PollDialogProps) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(EMPTY_OPTIONS);
  const [disclosed, setDisclosed] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    requestId.current += 1;
    setPending(false);
    setError(null);
    setQuestion("");
    setOptions(EMPTY_OPTIONS);
    setDisclosed(true);
  }, [open, roomId]);

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) requestId.current += 1;
    onOpenChange(nextOpen);
  }

  function updateOption(index: number, value: string) {
    setOptions((current) => current.map((option, i) => (i === index ? value : option)));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalizedQuestion = question.trim();
    const normalizedOptions = options.map((option) => option.trim());
    if (!normalizedQuestion || normalizedOptions.some((option) => !option)) {
      setError("Add a question and fill in every option.");
      return;
    }
    if (new Set(normalizedOptions).size !== normalizedOptions.length) {
      setError("Each option must be unique.");
      return;
    }

    const id = ++requestId.current;
    setPending(true);
    setError(null);
    try {
      await createPoll(roomId, normalizedQuestion, normalizedOptions, disclosed);
      if (requestId.current === id) handleOpenChange(false);
    } catch {
      if (requestId.current === id) setError("The poll could not be created.");
    } finally {
      if (requestId.current === id) setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create poll</DialogTitle>
          <DialogDescription>
            Ask one question with up to 20 choices. Voters can select one answer.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="poll-question">Question</Label>
            <Input
              id="poll-question"
              value={question}
              onChange={(event) => setQuestion(event.currentTarget.value)}
              placeholder="What should we choose?"
              maxLength={500}
              required
              disabled={pending}
              autoFocus
            />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-foreground">Options</legend>
            {options.map((option, index) => (
              <div key={index} className="flex items-center gap-2">
                <Label className="sr-only" htmlFor={`poll-option-${index}`}>
                  Option {index + 1}
                </Label>
                <Input
                  id={`poll-option-${index}`}
                  value={option}
                  onChange={(event) => updateOption(index, event.currentTarget.value)}
                  placeholder={`Option ${index + 1}`}
                  maxLength={200}
                  required
                  disabled={pending}
                />
                {options.length > 2 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove option ${index + 1}`}
                    disabled={pending}
                    onClick={() =>
                      setOptions((current) => current.filter((_, i) => i !== index))
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            ))}
            {options.length < 20 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => setOptions((current) => [...current, ""])}
              >
                <Plus className="size-4" />
                Add option
              </Button>
            )}
          </fieldset>

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3">
            <input
              type="checkbox"
              checked={disclosed}
              onChange={(event) => setDisclosed(event.currentTarget.checked)}
              disabled={pending}
              className="mt-0.5 size-4 accent-primary"
            />
            <span>
              <span className="block text-sm font-medium text-foreground">Show live results</span>
              <span className="block text-xs text-muted-foreground">
                Turn this off to hide totals until the poll is ended.
              </span>
            </span>
          </label>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create poll"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
