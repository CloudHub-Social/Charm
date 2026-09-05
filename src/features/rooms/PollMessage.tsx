import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { useDisplayFormats } from "@/features/appearance/useDisplayFormats";
import { logAndIgnore } from "@/lib/logAndIgnore";
import type { RoomMessageSummary } from "@/lib/matrix";
import {
  confirmPollEndSynced,
  discardPollEnd,
  discardPollVote,
  endPoll,
  getPendingPollEnd,
  getPendingPollVote,
  retryPollEnd,
  retryPollVote,
  voteOnPoll,
} from "@/lib/matrix";
import { cn } from "@/lib/utils";
import { MessageActions } from "./MessageActions";
import { ReactionBar } from "./ReactionBar";
import { SeenByChips } from "./SeenByChips";
import { formatTime, type MessageRowLayoutProps } from "./messageRowShared";

interface PollMessageProps {
  message: RoomMessageSummary;
  roomId: string;
  own: boolean;
  mutationsDisabled?: boolean;
  rowActions?: MessageRowLayoutProps;
  recoveryOnly?: boolean;
}

const acknowledgedPollCloses = new Map<string, string>();

function pollCloseKey(accountId: string, roomId: string, eventId: string) {
  return `${accountId}\u0000${roomId}\u0000${eventId}`;
}

export function resetAcknowledgedPollClosesForTests() {
  acknowledgedPollCloses.clear();
}

export function PollMessage({
  message,
  roomId,
  own,
  mutationsDisabled = false,
  rowActions,
  recoveryOnly = false,
}: PollMessageProps) {
  const { clockFormat } = useDisplayFormats();
  const poll = message.poll;
  const hasPoll = poll != null;
  const pollEnded = poll?.ended ?? false;
  const accountId = rowActions?.currentUserId ?? message.sender;
  const closeKey = pollCloseKey(accountId, roomId, message.event_id);
  // Timeline snapshots are the bounded reconciliation signal for a queued
  // close. Include vote/content changes as well as end/edit flags so a
  // rejection observed alongside an unrelated vote cannot remain hidden.
  const pollRevision = `${message.event_id}:${JSON.stringify(poll)}`;
  const lastEndStateRevision = useRef<string | null>(null);
  const shouldRestoreEnd = Boolean(
    own &&
    (recoveryOnly || (message.poll && !message.poll.ended)) &&
    message.event_id.startsWith("$"),
  );
  const [pendingAnswerId, setPendingAnswerId] = useState<string | null>(null);
  const [voteTransactionId, setVoteTransactionId] = useState<string | null>(null);
  const [voteFailed, setVoteFailed] = useState(false);
  const [restoringVoteState, setRestoringVoteState] = useState(hasPoll);
  const [voteRecheck, setVoteRecheck] = useState(0);
  const [ending, setEnding] = useState(false);
  const [restoringEndState, setRestoringEndState] = useState(shouldRestoreEnd);
  const [endRequestPending, setEndRequestPending] = useState(false);
  const [endTransactionId, setEndTransactionId] = useState<string | null>(null);
  const [endAcknowledged, setEndAcknowledged] = useState(false);
  const [endFailed, setEndFailed] = useState(false);
  const [endRecheck, setEndRecheck] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if ((!hasPoll && !recoveryOnly) || !message.event_id.startsWith("$")) {
      setPendingAnswerId(null);
      setVoteTransactionId(null);
      setVoteFailed(false);
      setRestoringVoteState(false);
      return;
    }
    let active = true;
    let retryTimer: number | undefined;
    setRestoringVoteState(true);
    void getPendingPollVote(roomId, message.event_id)
      .then(async (pending) => {
        if (!active) return;
        if (!pending) {
          setPendingAnswerId(null);
          setVoteTransactionId(null);
          setVoteFailed(false);
          setError((current) => (current === "Your vote could not be sent." ? null : current));
          return;
        }
        // A response to an already-ended poll can never become valid. Do
        // not offer a retry that would send a stale relation after another
        // client closed the poll; release the durable queue lock instead.
        if (pollEnded && pending.failed) {
          try {
            const discarded = await discardPollVote(
              roomId,
              message.event_id,
              pending.transaction_id,
            );
            if (!active) return;
            if (!discarded) {
              setVoteRecheck((revision) => revision + 1);
              return;
            }
            setPendingAnswerId(null);
            setVoteTransactionId(null);
            setVoteFailed(false);
            setError(null);
          } catch {
            if (active) setError("The failed vote could not be discarded.");
          }
          return;
        }
        setPendingAnswerId(pending.answer_id);
        setVoteTransactionId(pending.transaction_id);
        setVoteFailed(pending.failed);
        if (pending.failed) setError("Your vote could not be sent.");
      })
      .catch(() => {
        // An idle room may not produce another timeline revision. Keep
        // retrying the local durable queue lookup until recovery state is
        // visible again or this row unmounts.
        if (active) {
          retryTimer = window.setTimeout(() => setVoteRecheck((revision) => revision + 1), 2_000);
        }
      })
      .finally(() => {
        if (active) setRestoringVoteState(false);
      });
    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [hasPoll, message.event_id, pollEnded, pollRevision, recoveryOnly, roomId, voteRecheck]);
  useEffect(() => {
    if (!voteTransactionId || voteFailed) return;
    const timeout = window.setTimeout(() => setVoteRecheck((revision) => revision + 1), 2_000);
    return () => window.clearTimeout(timeout);
  }, [voteFailed, voteRecheck, voteTransactionId]);
  useEffect(() => {
    const acknowledged = pollEnded ? undefined : acknowledgedPollCloses.get(closeKey);
    if (pollEnded) {
      acknowledgedPollCloses.delete(closeKey);
      if (own && message.event_id.startsWith("$")) {
        void confirmPollEndSynced(roomId, message.event_id).catch(logAndIgnore);
      }
    }
    setEnding(Boolean(acknowledged));
    setEndRequestPending(false);
    setEndTransactionId(acknowledged ?? null);
    setEndAcknowledged(Boolean(acknowledged));
    setEndFailed(false);
    setEndRecheck(0);
    setError(null);
  }, [closeKey, message.event_id, own, pollEnded, roomId]);
  useEffect(() => {
    if (
      !own ||
      (!hasPoll && !recoveryOnly) ||
      !message.event_id.startsWith("$") ||
      endRequestPending ||
      (endTransactionId !== null &&
        !pollEnded &&
        lastEndStateRevision.current === `${pollRevision}:${endRecheck}`)
    ) {
      setRestoringEndState(false);
      return;
    }
    lastEndStateRevision.current = `${pollRevision}:${endRecheck}`;
    let active = true;
    setRestoringEndState(true);
    void getPendingPollEnd(roomId, message.event_id)
      .then(async (pending) => {
        if (!active) return;
        if (!pending) {
          acknowledgedPollCloses.delete(closeKey);
          setEndTransactionId(null);
          setEnding(false);
          setEndAcknowledged(false);
          setEndFailed(false);
          setError(null);
          return;
        }
        if (pollEnded) {
          if (pending.failed) {
            try {
              await discardPollEnd(roomId, message.event_id, pending.transaction_id);
              if (!active) return;
              setError(null);
            } catch {
              if (active) setError("The failed poll close could not be discarded.");
              return;
            }
          }
          acknowledgedPollCloses.delete(closeKey);
          setEndTransactionId(null);
          setEnding(false);
          setEndAcknowledged(false);
          setEndFailed(false);
          return;
        }
        setEndTransactionId(pending.transaction_id);
        setEnding(true);
        setEndFailed(pending.failed);
        if (pending.failed) {
          acknowledgedPollCloses.delete(closeKey);
          setEndAcknowledged(false);
          setError("The poll could not be ended.");
        } else {
          // Once restored, retain the close admission lock even if the send
          // queue removes its successful echo before /sync reports the end.
          acknowledgedPollCloses.set(closeKey, pending.transaction_id);
          setEndAcknowledged(true);
        }
      })
      .catch(() => {
        // The mutation command still rejects votes while a close is queued.
      })
      .finally(() => {
        if (active) setRestoringEndState(false);
      });
    return () => {
      active = false;
    };
  }, [
    closeKey,
    endRequestPending,
    endAcknowledged,
    endRecheck,
    endTransactionId,
    hasPoll,
    message.event_id,
    own,
    pollEnded,
    pollRevision,
    recoveryOnly,
    roomId,
  ]);
  useEffect(() => {
    if (!endTransactionId || pollEnded || endRequestPending || endFailed) return;
    const timeout = window.setTimeout(() => setEndRecheck((revision) => revision + 1), 2_000);
    return () => window.clearTimeout(timeout);
  }, [endFailed, endRecheck, endRequestPending, endTransactionId, pollEnded]);
  const hasRealEventId = message.event_id.startsWith("$");
  const canEndPoll = own;
  const ended = poll?.ended ?? false;
  const unsupportedSelectionCount = poll?.max_selections !== 1;

  function getActionsHandle() {
    if (!rowActions) return undefined;
    return rowActions.getActionsHandle(rowActions.rowKey);
  }

  async function vote(answerId: string) {
    if (
      !poll ||
      poll.ended ||
      ending ||
      restoringEndState ||
      restoringVoteState ||
      unsupportedSelectionCount ||
      mutationsDisabled ||
      !hasRealEventId ||
      pendingAnswerId !== null
    )
      return;
    setPendingAnswerId(answerId);
    setError(null);
    try {
      const transactionId = await voteOnPoll(roomId, message.event_id, answerId);
      setVoteTransactionId(transactionId);
      setVoteFailed(false);
    } catch {
      setPendingAnswerId(null);
      setVoteTransactionId(null);
      setError("Your vote could not be sent.");
    }
  }

  async function retryVote() {
    if (message.redacted || !voteTransactionId || !voteFailed) return;
    setRestoringVoteState(true);
    try {
      const retried = await retryPollVote(roomId, message.event_id, voteTransactionId);
      if (!retried) {
        setPendingAnswerId(null);
        setVoteTransactionId(null);
        setVoteFailed(false);
        setError("The failed vote is no longer available to retry.");
        return;
      }
      setVoteFailed(false);
      setError(null);
      setVoteRecheck((revision) => revision + 1);
    } catch {
      setError("Your vote could not be retried.");
    } finally {
      setRestoringVoteState(false);
    }
  }

  async function abandonVote() {
    if (!voteTransactionId || !voteFailed) return;
    setRestoringVoteState(true);
    try {
      const discarded = await discardPollVote(roomId, message.event_id, voteTransactionId);
      if (!discarded) {
        setVoteRecheck((revision) => revision + 1);
        return;
      }
      setPendingAnswerId(null);
      setVoteTransactionId(null);
      setVoteFailed(false);
      setError(null);
    } catch {
      setError("The failed vote could not be discarded.");
    } finally {
      setRestoringVoteState(false);
    }
  }

  async function end() {
    const retryingFailedEnd = endTransactionId !== null && endFailed;
    if (
      !canEndPoll ||
      ended ||
      (message.redacted && retryingFailedEnd) ||
      (mutationsDisabled && !retryingFailedEnd) ||
      !hasRealEventId ||
      restoringEndState ||
      restoringVoteState ||
      endRequestPending ||
      (endTransactionId !== null && !endFailed) ||
      pendingAnswerId !== null
    )
      return;
    setEnding(true);
    setEndRequestPending(true);
    setError(null);
    try {
      if (endTransactionId && endFailed) {
        const retried = await retryPollEnd(roomId, message.event_id, endTransactionId);
        if (!retried) {
          acknowledgedPollCloses.delete(closeKey);
          setEndTransactionId(null);
          setEndAcknowledged(false);
          setEndFailed(false);
          setEnding(false);
          setError("The failed poll close is no longer available to retry.");
          return;
        }
        acknowledgedPollCloses.set(closeKey, endTransactionId);
        setEndAcknowledged(true);
        setEndFailed(false);
      } else {
        const transactionId = await endPoll(roomId, message.event_id);
        acknowledgedPollCloses.set(closeKey, transactionId);
        setEndTransactionId(transactionId);
        setEndAcknowledged(true);
        setEndFailed(false);
      }
    } catch {
      setError("The poll could not be ended.");
      if (!endTransactionId) setEnding(false);
    } finally {
      setEndRequestPending(false);
    }
  }

  async function abandonEnd() {
    if (!endTransactionId || endRequestPending) return;
    setEndRequestPending(true);
    try {
      const discarded = await discardPollEnd(roomId, message.event_id, endTransactionId);
      if (!discarded) {
        setEndRecheck((revision) => revision + 1);
        return;
      }
      acknowledgedPollCloses.delete(closeKey);
      setEndTransactionId(null);
      setEndAcknowledged(false);
      setEndFailed(false);
      setEnding(false);
      setError(null);
    } catch {
      setError("The failed poll close could not be discarded.");
    } finally {
      setEndRequestPending(false);
    }
  }

  if (recoveryOnly) {
    if (!voteFailed && !endFailed && !error) return null;
    return (
      <section
        aria-label="Poll send recovery"
        className="mx-4 mb-2 rounded-lg border border-destructive/40 bg-card p-3 text-xs"
      >
        {voteFailed && voteTransactionId && (
          <div className="flex flex-wrap items-center gap-2">
            <p>Your poll vote failed to send.</p>
            {!pollEnded && !message.redacted && (
              <button
                type="button"
                className="rounded-md px-2 py-1 font-medium text-foreground hover:bg-accent disabled:opacity-50"
                disabled={restoringVoteState}
                onClick={() => void retryVote()}
              >
                Retry vote
              </button>
            )}
            <button
              type="button"
              className="rounded-md px-2 py-1 font-medium text-foreground hover:bg-accent disabled:opacity-50"
              disabled={restoringVoteState}
              onClick={() => void abandonVote()}
            >
              Discard vote
            </button>
          </div>
        )}
        {endFailed && endTransactionId && (
          <div className="flex flex-wrap items-center gap-2">
            <p>Your poll close failed to send.</p>
            {!message.redacted && (
              <button
                type="button"
                className="rounded-md px-2 py-1 font-medium text-foreground hover:bg-accent disabled:opacity-50"
                disabled={endRequestPending}
                onClick={() => void end()}
              >
                Retry close
              </button>
            )}
            <button
              type="button"
              className="rounded-md px-2 py-1 font-medium text-foreground hover:bg-accent disabled:opacity-50"
              disabled={endRequestPending}
              onClick={() => void abandonEnd()}
            >
              Discard close
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-1 text-destructive">
            {error}
          </p>
        )}
      </section>
    );
  }

  if (!poll) return null;
  const showResults = poll.kind === "disclosed" || ended;
  const totalVotes = poll.answers.reduce((sum, answer) => sum + answer.votes, 0);

  return (
    <div
      id={`message-${message.event_id}`}
      className={cn(
        "group mt-3 flex w-full max-w-md items-center gap-1",
        own && "ml-auto flex-row-reverse",
      )}
      onTouchStart={(event) => {
        // A held vote/profile/end control must not also open row actions.
        if (event.target instanceof Element && event.target.closest("button, a, input")) return;
        getActionsHandle()?.startLongPress();
      }}
      onTouchEnd={() => getActionsHandle()?.cancelLongPress()}
      onTouchCancel={() => getActionsHandle()?.cancelLongPress()}
      onTouchMove={() => getActionsHandle()?.cancelLongPress()}
    >
      <div className="min-w-0 flex-1">
        <article
          className="w-full rounded-xl border border-border bg-card p-4 shadow-xs"
          aria-label={`Poll: ${poll.question}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">
                {rowActions?.onSenderClick ? (
                  <button
                    type="button"
                    className="hover:underline"
                    onClick={() =>
                      rowActions.onSenderClick?.(
                        message.sender,
                        message.sender_display_name ?? message.sender,
                      )
                    }
                  >
                    {message.sender_display_name ?? message.sender}
                  </button>
                ) : (
                  (message.sender_display_name ?? message.sender)
                )}
              </p>
              <h3 className="mt-1 text-base font-semibold text-foreground">{poll.question}</h3>
            </div>
            <div className="shrink-0 text-right text-[11px] text-muted-foreground">
              <time>{formatTime(message.timestamp_ms, clockFormat)}</time>
              {poll.edited && <span className="ml-1">(edited)</span>}
              {rowActions?.isError && (
                <span className="ml-1 text-destructive">(failed to send)</span>
              )}
            </div>
          </div>

          <div className="mt-3 space-y-2">
            {poll.answers.map((answer) => {
              const percentage =
                totalVotes === 0 ? 0 : Math.round((answer.votes / totalVotes) * 100);
              const pending = pendingAnswerId === answer.id;
              return (
                <button
                  key={answer.id}
                  type="button"
                  aria-pressed={answer.selected_by_me}
                  disabled={
                    ended ||
                    ending ||
                    restoringEndState ||
                    restoringVoteState ||
                    unsupportedSelectionCount ||
                    mutationsDisabled ||
                    !hasRealEventId ||
                    pendingAnswerId !== null
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
                  {showResults && !unsupportedSelectionCount && (
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
                        {answer.votes}
                        {!unsupportedSelectionCount && ` · ${percentage}%`}
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
              {ended
                ? `${totalVotes} ${unsupportedSelectionCount ? "selections" : totalVotes === 1 ? "vote" : "votes"} · Poll closed`
                : showResults
                  ? `${totalVotes} ${unsupportedSelectionCount ? "selections" : totalVotes === 1 ? "vote" : "votes"}`
                  : "Results hidden until the poll closes"}
            </span>
            {canEndPoll && !ended && (
              <button
                type="button"
                onClick={() => void end()}
                disabled={
                  mutationsDisabled ||
                  !hasRealEventId ||
                  restoringEndState ||
                  restoringVoteState ||
                  endRequestPending ||
                  (endTransactionId !== null && !endFailed) ||
                  pendingAnswerId !== null
                }
                className="rounded-md px-2 py-1 font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                {endRequestPending
                  ? "Ending…"
                  : endFailed
                    ? "Retry closing poll"
                    : endTransactionId
                      ? "Close queued"
                      : "End poll"}
              </button>
            )}
          </div>
          {ending && !ended && !endRequestPending && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <p>Close queued. Waiting for the timeline to confirm.</p>
              {endFailed && endTransactionId && (
                <button
                  type="button"
                  className="rounded-md px-2 py-1 font-medium text-foreground hover:bg-accent"
                  onClick={() => void abandonEnd()}
                >
                  Discard failed close
                </button>
              )}
            </div>
          )}
          {voteFailed && voteTransactionId && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <p>Your vote failed to send.</p>
              <button
                type="button"
                className="rounded-md px-2 py-1 font-medium text-foreground hover:bg-accent disabled:opacity-50"
                disabled={restoringVoteState}
                onClick={() => void retryVote()}
              >
                Retry vote
              </button>
              <button
                type="button"
                className="rounded-md px-2 py-1 font-medium text-foreground hover:bg-accent disabled:opacity-50"
                disabled={restoringVoteState}
                onClick={() => void abandonVote()}
              >
                Discard vote
              </button>
            </div>
          )}
          {unsupportedSelectionCount && !poll.ended && (
            <p className="mt-2 text-xs text-muted-foreground">
              Voting on multi-select polls is not supported yet. Use another Matrix client to vote.
            </p>
          )}
          {error && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </article>
        {rowActions && (
          <SeenByChips
            readers={rowActions.readers}
            senderNameByUserId={rowActions.senderNameByUserId}
            className={cn("mt-0.5", own ? "justify-end" : "justify-start")}
          />
        )}
        {rowActions && (
          <ReactionBar
            accountId={rowActions.currentUserId ?? ""}
            reactions={message.reactions}
            onToggle={rowActions.onReact}
            disabled={rowActions.disableRelationActions}
            roomId={roomId}
            eventId={message.event_id}
          />
        )}
      </div>
      {rowActions && (
        <MessageActions
          ref={(element) => rowActions.registerActionsRef(rowActions.rowKey, element)}
          accountId={rowActions.currentUserId ?? ""}
          isOwn={own}
          canReply={false}
          canEdit={false}
          canRedact={rowActions.canRedact}
          canPin={rowActions.canPin}
          isPinned={rowActions.isPinned}
          disableRelationActions={rowActions.disableRelationActions}
          disableStableEventActions={rowActions.disableStableEventActions}
          mutationsDisabled={mutationsDisabled}
          isError={rowActions.isError}
          className="opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100"
          onReply={rowActions.onReply}
          onReact={rowActions.onReact}
          onEdit={rowActions.onEdit}
          onDelete={rowActions.onDelete}
          onPin={rowActions.onPin}
          onUnpin={rowActions.onUnpin}
          onCopy={rowActions.onCopy}
          onCopyLink={rowActions.onCopyLink}
          onBookmark={rowActions.onBookmark}
          onUnbookmark={rowActions.onUnbookmark}
          isBookmarked={rowActions.isBookmarked}
          onResend={rowActions.onResend}
          onDiscard={rowActions.onDiscard}
          onForward={undefined}
          onViewSource={rowActions.onViewSource}
          onReport={rowActions.onReport}
          isEdited={false}
          onViewEditHistory={undefined}
        />
      )}
    </div>
  );
}
