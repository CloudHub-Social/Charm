"use client";

import * as React from "react";
import { Label as LabelPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        // Explicit `text-foreground` — without it Label renders with no color
        // class at all and inherits whatever ambient text color surrounds it,
        // which is invisible/low-contrast the moment it's not nested under a
        // dark ancestor (e.g. on the light theme, or in an isolated a11y
        // check). See Charm 2.0 Spec 09's contrast-debt note.
        "flex items-center gap-2 text-sm leading-none font-medium text-foreground select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
