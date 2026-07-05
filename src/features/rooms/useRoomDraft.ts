/**
 * Per-room draft persistence seam. Day-1 is an in-memory no-op store (see
 * the spec's non-goals: autosave/restore across app restarts is Day-2) —
 * this exists so the composer already calls `getDraft`/`setDraft` on every
 * keystroke and room switch, and swapping in a real persisted backing store
 * later is a change to this module alone, not to every call site.
 */
const inMemoryDrafts = new Map<string, string>();

export function useRoomDraft(roomId: string) {
  return {
    getDraft(): string {
      return inMemoryDrafts.get(roomId) ?? "";
    },
    setDraft(value: string): void {
      inMemoryDrafts.set(roomId, value);
    },
  };
}
