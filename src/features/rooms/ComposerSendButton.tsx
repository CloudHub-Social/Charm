import { Send } from "lucide-react";
import { cn } from "@/lib/utils";

export function ComposerSendButton({
  mobile,
  disabled,
  onClick,
}: {
  mobile: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label="Send"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex shrink-0 items-center justify-center bg-primary-solid text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50",
        mobile ? "size-11 rounded-full" : "size-9 rounded-md",
      )}
    >
      <Send size={16} />
    </button>
  );
}
