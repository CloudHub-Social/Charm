import { MessageSquareIcon, PenSquareIcon, SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface OrientationPaneProps {
  onNext: () => void;
  /** True while `OnboardingScreen` hasn't yet resolved cross-signing status — see its doc comment for why Continue waits on it. */
  nextDisabled?: boolean;
}

export function OrientationPane({ onNext, nextDisabled }: OrientationPaneProps) {
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
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
      <Button className="h-11 w-full" onClick={onNext} disabled={nextDisabled}>
        Continue
      </Button>
    </div>
  );
}
