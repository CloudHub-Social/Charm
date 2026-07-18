import { useCallback, useState } from "react";

const STORAGE_KEY = "charm:recentReactions";
const MAX_RECENT = 8;
const STARTER_SET = ["👍", "❤️", "😂", "🎉"];

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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
export function useRecentReactions() {
  const [recent, setRecent] = useState<string[]>(() => readRecent());

  const recordReaction = useCallback((emoji: string) => {
    setRecent((prev) => {
      const next = [emoji, ...prev.filter((e) => e !== emoji)].slice(0, MAX_RECENT);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // best-effort — a full/unavailable localStorage just means the
        // in-memory ordering for this session is lost on reload.
      }
      return next;
    });
  }, []);

  return { recent, recordReaction };
}
