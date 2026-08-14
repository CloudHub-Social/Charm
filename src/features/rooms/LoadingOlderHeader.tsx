/** Stable Virtuoso header that reads pagination state from its context. */
export function LoadingOlderHeader({
  context,
}: {
  context?: { loadingMore: boolean; hasMore: boolean };
}) {
  if (context?.loadingMore) {
    return (
      <p className="pb-2 text-center text-xs text-muted-foreground">Loading older messages…</p>
    );
  }
  if (context && !context.hasMore) {
    return (
      <div className="flex items-center gap-3 pb-3 text-[11px] font-medium text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <span>You're all caught up</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }
  return null;
}
