import * as React from "react";
import { CheckIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

function Switch({
  className,
  checked,
  defaultChecked,
  onCheckedChange,
  onClick,
  ...props
}: Omit<React.ComponentProps<"button">, "onChange"> & {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}) {
  const [uncontrolledChecked, setUncontrolledChecked] = React.useState(defaultChecked ?? false);
  const isControlled = checked !== undefined;
  const isChecked = isControlled ? checked : uncontrolledChecked;

  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={isChecked}
      data-slot="switch"
      data-state={isChecked ? "checked" : "unchecked"}
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border border-border bg-muted transition-colors outline-none data-[state=checked]:border-primary data-[state=checked]:bg-primary focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      onClick={(event) => {
        const nextChecked = !isChecked;
        if (!isControlled) {
          setUncontrolledChecked(nextChecked);
        }
        onCheckedChange?.(nextChecked);
        onClick?.(event);
      }}
    >
      <span
        aria-hidden="true"
        data-slot="switch-thumb"
        data-state={isChecked ? "checked" : "unchecked"}
        className="pointer-events-none flex size-4 translate-x-1 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm transition-transform data-[state=checked]:translate-x-5 data-[state=checked]:text-primary"
      >
        {isChecked ? <CheckIcon className="size-3" /> : <XIcon className="size-3" />}
      </span>
    </button>
  );
}

export { Switch };
