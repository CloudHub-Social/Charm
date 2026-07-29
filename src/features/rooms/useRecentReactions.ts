import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY_PREFIX = "charm:recentReactions:";
const MAX_RECENT = 8;
const STARTER_SET = ["👍", "❤️", "😂", "🎉"];

type RecentReactionSubscriber = (recent: string[]) => void;

// `storage` events are not emitted in the tab that made the localStorage
// change, so mounted message rows need a small in-process notification
// channel. Subscribers are partitioned by account and removed when the last
// hook instance unmounts; reaction habits are never held in a global cache.
const subscribersByAccount = new Map<string, Set<RecentReactionSubscriber>>();

function subscribe(accountId: string, subscriber: RecentReactionSubscriber): () => void {
  const subscribers = subscribersByAccount.get(accountId) ?? new Set();
  subscribers.add(subscriber);
  subscribersByAccount.set(accountId, subscribers);

  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      subscribersByAccount.delete(accountId);
    }
  };
}

function publish(
  accountId: string,
  recent: string[],
  source: RecentReactionSubscriber | null,
): void {
  for (const subscriber of subscribersByAccount.get(accountId) ?? []) {
    if (subscriber !== source) {
      subscriber(recent);
    }
  }
}

function storageKey(accountId: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(accountId)}`;
}

function readRecent(accountId: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(accountId));
    if (!raw) return STARTER_SET;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return STARTER_SET;
    const recent = parsed.filter((entry): entry is string => typeof entry === "string");
    return recent.length > 0 ? recent : STARTER_SET;
  } catch {
    return STARTER_SET;
  }
}

/**
 * Tracks the user's most-recently-used reaction emoji in `localStorage`,
 * most-recent-first, so the quick-react row can offer one-tap access to
 * whatever the user actually reaches for instead of a fixed set. Falls back
 * to a small starter set until the user has reacted at least once.
 */
export function useRecentReactions(accountId: string) {
  const [state, setState] = useState(() => ({
    accountId,
    recent: readRecent(accountId),
  }));
  const currentStateRef = useRef(state);
  const subscriberRef = useRef<RecentReactionSubscriber | null>(null);
  // Account changes must take effect during render, rather than in a passive
  // effect that would briefly expose the previous account's reaction habits.
  const recent = state.accountId === accountId ? state.recent : readRecent(accountId);
  currentStateRef.current = { accountId, recent };

  useEffect(() => {
    const subscriber: RecentReactionSubscriber = (next) => {
      const nextState = { accountId, recent: next };
      currentStateRef.current = nextState;
      setState(nextState);
    };
    subscriberRef.current = subscriber;
    const unsubscribe = subscribe(accountId, subscriber);

    return () => {
      unsubscribe();
      if (subscriberRef.current === subscriber) {
        subscriberRef.current = null;
      }
    };
  }, [accountId]);

  const recordReaction = useCallback(
    (emoji: string) => {
      const current =
        currentStateRef.current.accountId === accountId
          ? currentStateRef.current.recent
          : readRecent(accountId);
      const next = [emoji, ...current.filter((e) => e !== emoji)].slice(0, MAX_RECENT);
      try {
        localStorage.setItem(storageKey(accountId), JSON.stringify(next));
      } catch {
        // best-effort — a full/unavailable localStorage just means the
        // in-memory ordering for this session is lost on reload.
      }
      const nextState = { accountId, recent: next };
      currentStateRef.current = nextState;
      setState(nextState);
      publish(accountId, next, subscriberRef.current);
    },
    [accountId],
  );

  return { recent, recordReaction };
}
