import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { RoomMessageSummary } from "@/lib/matrix";
import { endPoll, voteOnPoll } from "@/lib/matrix";
import { cn } from "@/lib/utils";
import { formatTime } from "./messageRowShared";

interface PollMessageProps {
  message: RoomMessageSummary;
  roomId: string;
  own: boolean;
  mutationsDisabled?: boolean;
}

export function PollMessage({ message, roomId, own, mutationsDisabled = false }: PollMessageProps) {
  const poll = message.poll;
  const [pendingAnswerId, setPendingAnswerId] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!poll) return null;
  const currentPoll = poll;

  const hasRealEventId = message.event_id.startsWith("$");
  const showResults = poll.kind === "disclosed" || poll.ended;
  const totalVotes = poll.answers.reduce((sum, answer) => sum + answer.votes, 0);

  async function vote(answerId: string) {
    if (currentPoll.ended || mutationsDisabled || !hasRealEventId || pendingAnswerId !== null)
      return;
    setPendingAnswerId(answerId);
    setError(null);
    try {
      await voteOnPoll(roomId, message.event_id, answerId);
    } catch {
      setError("Your vote could not be sent.");
    } finally {
      setPendingAnswerId(null);
    }
  }

  async function end() {
    if (!own || currentPoll.ended || mutationsDisabled || !hasRealEventId || ending) return;
    setEnding(true);
    setError(null);
    try {
      await endPoll(roomId, message.event_id);
    } catch {
      setError("The poll could not be ended.");
    } finally {
      setEnding(false);
    }
  }

  return (
    <article
      id={`message-${message.event_id}`}
      className={cn(
        "mt-3 w-full max-w-md rounded-xl border border-border bg-card p-4 shadow-xs",
        own && "ml-auto",
      )}
      aria-label={`Poll: ${poll.question}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">
            {message.sender_display_name ?? message.sender}
          </p>
          <h3 className="mt-1 text-base font-semibold text-foreground">{poll.question}</h3>
        </div>
        <time className="shrink-0 text-[11px] text-muted-foreground">
          {formatTime(message.timestamp_ms)}
        </time>
      </div>

      <div className="mt-3 space-y-2">
        {poll.answers.map((answer) => {
          const percentage = totalVotes === 0 ? 0 : Math.round((answer.votes / totalVotes) * 100);
          const pending = pendingAnswerId === answer.id;
          return (
            <button
              key={answer.id}
              type="button"
              aria-pressed={answer.selected_by_me}
              disabled={
                poll.ended || mutationsDisabled || !hasRealEventId || pendingAnswerId !== null
              }
              onClick={() => void vote(answer.id)}
              className={cn(
                "relative flex min-h-11 w-full overflow-hidden rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:cursor-not-allowed disabled:opacity-70",
                answer.selected_by_me
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-background text-foreground hover:bg-accent",
              )}
            >
              {showResults && (
                <span
                  className="absolute inset-y-0 left-0 bg-primary/10"
                  style={{ width: `${percentage}%` }}
                  aria-hidden="true"
                />
              )}
              <span className="relative flex w-full items-center justify-between gap-3">
                <span className="min-w-0 break-words">{answer.text}</span>
                {pending ? (
                  <LoaderCircle
                    className="size-4 shrink-0 animate-spin"
                    aria-label="Sending vote"
                  />
                ) : showResults ? (
                  <span className="shrink-0 text-xs font-medium text-muted-foreground">
                    {answer.votes} · {percentage}%
                  </span>
                ) : answer.selected_by_me ? (
                  <span className="shrink-0 text-xs font-medium text-primary">Selected</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          {poll.ended
            ? `${totalVotes} ${totalVotes === 1 ? "vote" : "votes"} · Poll closed`
            : showResults
              ? `${totalVotes} ${totalVotes === 1 ? "vote" : "votes"}`
              : "Results hidden until the poll closes"}
        </span>
        {own && !poll.ended && (
          <button
            type="button"
            onClick={() => void end()}
            disabled={mutationsDisabled || !hasRealEventId || ending}
            className="rounded-md px-2 py-1 font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {ending ? "Ending…" : "End poll"}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </article>
  );
}
