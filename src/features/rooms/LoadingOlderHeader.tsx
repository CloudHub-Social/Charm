import { cn } from "@/lib/utils";

/** Stable Virtuoso header that reads pagination state from its context. */
export function LoadingOlderHeader({
  context,
}: {
  context?: { loadingMore: boolean; hasMore: boolean; uxRefreshEnabled?: boolean };
}) {
  const gutters = cn("px-4 pt-4", context?.uxRefreshEnabled && "px-3 pt-5 sm:px-6");
  if (context?.loadingMore) {
    return (
      <p className={cn(gutters, "pb-2 text-center text-xs text-muted-foreground")}>
        Loading older messages…
      </p>
    );
  }
  if (context && !context.hasMore) {
    return (
      <div
        className={cn(
          gutters,
          "flex items-center gap-3 pb-3 text-[11px] font-medium text-muted-foreground",
        )}
      >
        <span className="h-px flex-1 bg-border" />
        <span>You're all caught up</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }
  return null;
}
