import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { logout, reauthenticatePassword, type LoginResponse } from "@/lib/matrix";

interface ReauthenticationScreenProps {
  session: LoginResponse;
  onReauthenticated: (session: LoginResponse) => void;
  onUseAnotherAccount: () => void;
}

export function ReauthenticationScreen({
  session,
  onReauthenticated,
  onUseAnotherAccount,
}: ReauthenticationScreenProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || pending || loggingOut) return;
    setPending(true);
    setError(null);
    try {
      const refreshed = await reauthenticatePassword(password);
      if (refreshed.user_id !== session.user_id || refreshed.device_id !== session.device_id) {
        throw new Error("The homeserver returned a different Matrix device. Sign in again instead.");
      }
      setPassword("");
      onReauthenticated(refreshed);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  };

  const useAnotherAccount = async () => {
    if (pending || loggingOut) return;
    setLoggingOut(true);
    setError(null);
    try {
      await logout();
      onUseAnotherAccount();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-xl font-semibold">Sign in again</h1>
          <p className="text-sm text-muted-foreground">
            Your homeserver ended this login. Enter the password for {session.user_id} to keep
            using this encrypted device.
          </p>
        </div>

        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor="reauthentication-password">Password</Label>
            <Input
              id="reauthentication-password"
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={pending || loggingOut}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
            />
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <Button className="w-full" type="submit" disabled={!password || pending || loggingOut}>
            {pending ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : null}
            Continue on this device
          </Button>
          <Button
            className="w-full"
            type="button"
            variant="ghost"
            disabled={pending || loggingOut}
            onClick={() => void useAnotherAccount()}
          >
            {loggingOut ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : null}
            Use another account
          </Button>
        </form>
      </div>
    </main>
  );
}
