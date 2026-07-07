import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // `bg-primary-solid` (not `bg-primary`): same two-incompatible-
        // contexts issue as destructive below — accent-500-derived
        // `--primary`/`--color-accent` is tuned for accent text/links on
        // the canvas, not a solid fill under near-white text (3.0-3.4:1 as
        // a fill, below WCAG AA). `--primary-solid` is chosen to clear
        // 4.5:1 against `--primary-foreground`. See tokens.css.
        default: "bg-primary-solid text-primary-foreground hover:bg-primary-solid/90",
        // `bg-destructive-solid` (not `bg-destructive`): the danger token is
        // tuned for danger TEXT on the canvas, which needs a different
        // (lighter, theme-relative) value than a SOLID fill under white
        // text needs — #ef4444 only reaches 3.51:1 against white text,
        // below WCAG AA's 4.5:1 floor for normal text, in every theme.
        // `--destructive-solid` is a theme-invariant value chosen to clear
        // 4.5:1 against white text. See tokens.css's definition.
        destructive:
          "bg-destructive-solid text-white hover:bg-destructive-solid/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        // Explicit `text-foreground`: ghost has no background at rest, so
        // without an explicit color class it inherits ambient text color
        // rather than a token — invisible/low-contrast outside a dark
        // ancestor (e.g. the light theme). See Charm 2.0 Spec 09's
        // contrast-debt note.
        ghost:
          "text-foreground hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
