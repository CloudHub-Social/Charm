import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SettingsCardProps {
  /** Category heading rendered above the card (e.g. "Security", "Current") — omit for a card with no heading. */
  heading?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Bordered/rounded card grouping one or more `SettingTile` rows under an
 * optional category heading — the shared layout convention every settings
 * panel uses (matches Charm 1.0's `SequenceCard`, ported to Charm 2.0's own
 * design tokens rather than its styling). Rows are separated with a divider,
 * not individual card borders.
 */
export function SettingsCard({ heading, children, className }: SettingsCardProps) {
  return (
    <div className={cn(heading && "space-y-2", className)}>
      {heading ? <h2 className="text-sm font-semibold text-foreground">{heading}</h2> : null}
      <div className="divide-y divide-border rounded-lg border border-border bg-card">
        {children}
      </div>
    </div>
  );
}

type SettingTileProps =
  | {
      title: ReactNode;
      description?: ReactNode;
      /** Trailing control — a button, dropdown, checkbox, switch, etc. */
      control?: ReactNode;
      children?: undefined;
      className?: string;
    }
  | {
      title?: undefined;
      description?: undefined;
      control?: undefined;
      /** Renders the tile's own content instead of the title/description/control layout — for rows that don't fit that shape (e.g. a list). */
      children: ReactNode;
      className?: string;
    };

/** One row within a `SettingsCard`: title + optional description on the left, a trailing control on the right. */
export function SettingTile({
  title,
  description,
  control,
  children,
  className,
}: SettingTileProps) {
  if (children) {
    return <div className={cn("px-4 py-3", className)}>{children}</div>;
  }

  return (
    <div className={cn("flex items-center justify-between gap-4 px-4 py-3", className)}>
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {control ? <div className="shrink-0">{control}</div> : null}
    </div>
  );
}
