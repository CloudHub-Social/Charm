import { ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";

interface PollComposerActionProps {
  mobile: boolean;
  disabled: boolean;
  onClick: () => void;
}

export function PollComposerAction({ mobile, disabled, onClick }: PollComposerActionProps) {
  return (
    <button
      type="button"
      aria-label="Create poll"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex shrink-0 items-center justify-center text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
        mobile ? "size-11 rounded-full" : "size-9 rounded-md",
      )}
    >
      <ListChecks size={18} />
    </button>
  );
}
