import { useCallback, useState } from "react";

const STORAGE_KEY_PREFIX = "charm:recentReactions:";
const MAX_RECENT = 8;
const STARTER_SET = ["👍", "❤️", "😂", "🎉"];

function storageKey(accountId: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(accountId)}`;
}

function readRecent(accountId: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(accountId));
    if (!raw) return STARTER_SET;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return STARTER_SET;
    return parsed.filter((entry): entry is string => typeof entry === "string");
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
  // Account changes must take effect during render, rather than in a passive
  // effect that would briefly expose the previous account's reaction habits.
  const recent = state.accountId === accountId ? state.recent : readRecent(accountId);

  const recordReaction = useCallback(
    (emoji: string) => {
      setState((prev) => {
        const current = prev.accountId === accountId ? prev.recent : readRecent(accountId);
        const next = [emoji, ...current.filter((e) => e !== emoji)].slice(0, MAX_RECENT);
        try {
          localStorage.setItem(storageKey(accountId), JSON.stringify(next));
        } catch {
          // best-effort — a full/unavailable localStorage just means the
          // in-memory ordering for this session is lost on reload.
        }
        return { accountId, recent: next };
      });
    },
    [accountId],
  );

  return { recent, recordReaction };
}
