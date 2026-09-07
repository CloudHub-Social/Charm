import { useAtomValue } from "jotai";
import { MessageSquareIcon, PenSquareIcon, SettingsIcon } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useFlag } from "@/featureFlags";
import { useAppearance } from "@/features/appearance/useAppearance";
import { appearancePersistenceStateAtom, type MessageLayout } from "@/features/appearance/atoms";
import { cn } from "@/lib/utils";

interface OrientationPaneProps {
  onNext: () => void;
  /** True while `OnboardingScreen` hasn't yet resolved cross-signing status — see its doc comment for why Continue waits on it. */
  nextDisabled?: boolean;
}

export function OrientationPane({ onNext, nextDisabled }: OrientationPaneProps) {
  const uxRefreshEnabled = useFlag("ux_refresh_v1");
  const { messageLayout, setMessageLayout } = useAppearance();
  const appearancePersistenceState = useAtomValue(appearancePersistenceStateAtom);

  useEffect(() => {
    if (uxRefreshEnabled && appearancePersistenceState === false) {
      setMessageLayout("discord");
    }
  }, [appearancePersistenceState, setMessageLayout, uxRefreshEnabled]);

  const layouts: { value: MessageLayout; label: string; description: string }[] = [
    { value: "discord", label: "Modern", description: "Warm, open, and easy to scan" },
    { value: "bubble", label: "Bubbles", description: "Compact conversational bubbles" },
    { value: "irc", label: "IRC", description: "Dense single-line messages" },
  ];

  return (
    <div
      className={cn(
        "flex w-full max-w-sm flex-col items-center gap-6 text-center",
        uxRefreshEnabled && "max-w-2xl",
      )}
    >
      <h1 className="text-xl font-bold text-foreground">Welcome to Charm</h1>
      <p className="text-sm text-muted-foreground">
        A fast, secure Matrix client. Here's where the essentials live.
      </p>
      <ul className="w-full space-y-3 text-left text-sm text-foreground">
        <li className="flex items-center gap-3">
          <MessageSquareIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
          Your rooms live in the list on the left.
        </li>
        <li className="flex items-center gap-3">
          <PenSquareIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
          Type in the composer at the bottom of a room to send a message.
        </li>
        <li className="flex items-center gap-3">
          <SettingsIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
          Settings — devices, notifications, appearance — are one click away.
        </li>
      </ul>
      {uxRefreshEnabled && (
        <fieldset className="w-full">
          <legend className="mb-3 text-sm font-bold text-foreground">
            Choose your conversation style
          </legend>
          <div className="grid gap-2 sm:gap-3 sm:grid-cols-3">
            {layouts.map((layout) => {
              const selected = messageLayout === layout.value;
              return (
                <button
                  key={layout.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setMessageLayout(layout.value)}
                  className={cn(
                    "flex min-h-20 flex-col rounded-2xl border p-3 text-left transition sm:min-h-32 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ux-shell-focus)]",
                    selected
                      ? "border-[var(--ux-shell-focus)] bg-[var(--ux-selection)]"
                      : "border-[var(--ux-shell-border)] bg-[var(--ux-content-raised)] hover:border-[var(--ux-shell-border-strong)]",
                  )}
                >
                  <span
                    className="mb-2 flex h-9 w-full flex-col justify-center gap-1 rounded-xl bg-[var(--ux-content-bg)] px-2 sm:mb-3 sm:h-12"
                    aria-hidden="true"
                  >
                    <span
                      className={cn(
                        "h-1.5 rounded-full bg-muted-foreground/50",
                        layout.value === "irc" ? "w-11/12" : "w-7/12",
                      )}
                    />
                    <span
                      className={cn(
                        "h-1.5 rounded-full bg-muted-foreground/30",
                        layout.value === "bubble" ? "ml-auto w-5/12" : "w-9/12",
                      )}
                    />
                    <span className="h-1.5 w-6/12 rounded-full bg-muted-foreground/20" />
                  </span>
                  <span className="text-sm font-bold text-foreground">{layout.label}</span>
                  <span className="mt-0.5 text-xs leading-4 text-muted-foreground">
                    {layout.description}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>
      )}
      <Button className="h-11 w-full" onClick={onNext} disabled={nextDisabled}>
        Continue
      </Button>
    </div>
  );
}
