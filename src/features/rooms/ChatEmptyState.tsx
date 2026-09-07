import { MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export function NoRoomSelectedState({ refreshed }: { refreshed: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-1 items-center justify-center text-sm text-muted-foreground",
        refreshed && "bg-[var(--ux-content-bg)] px-6 text-center",
      )}
    >
      <div
        className={cn(
          refreshed &&
            "max-w-sm rounded-3xl border border-[var(--ux-shell-border)] bg-[var(--ux-content-raised)] px-8 py-10 shadow-lg",
        )}
      >
        {refreshed && (
          <span className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-[var(--ux-selection)] text-[var(--ux-selection-strong)]">
            <MessageCircle className="size-7" aria-hidden="true" />
          </span>
        )}
        <p className={cn(refreshed && "text-base font-bold text-foreground")}>
          Select a room to start chatting
        </p>
        {refreshed && (
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Your draft and current conversation stay ready while you move around Charm.
          </p>
        )}
      </div>
    </div>
  );
}

export function NoMessagesState() {
  return (
    <div className="flex flex-1 items-center justify-center px-6 text-center">
      <div className="flex max-w-xs flex-col items-center">
        <span className="mb-3 flex size-12 items-center justify-center rounded-full bg-secondary text-muted-foreground">
          <MessageCircle className="size-6" aria-hidden="true" />
        </span>
        <p className="text-sm font-semibold text-foreground">No messages yet</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Send the first message to start the conversation.
        </p>
      </div>
    </div>
  );
}
