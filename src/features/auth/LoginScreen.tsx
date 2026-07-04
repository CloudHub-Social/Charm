import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { login, type LoginResponse } from "@/lib/matrix";

interface LoginScreenProps {
  onSignedIn: (session: LoginResponse) => void;
}

export function LoginScreen({ onSignedIn }: LoginScreenProps) {
  const [homeserverUrl, setHomeserverUrl] = useState("http://localhost:8008");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await login({ homeserver_url: homeserverUrl, username, password });
      onSignedIn(response);
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <form onSubmit={handleSubmit} className="flex w-90 flex-col gap-5">
        <div className="flex flex-col gap-1 text-center">
          <h1 className="text-xl font-bold text-foreground">Charm</h1>
          <p className="text-sm text-muted-foreground">Sign in to your homeserver</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="homeserver-url">Homeserver URL</Label>
          <Input
            id="homeserver-url"
            value={homeserverUrl}
            onChange={(e) => setHomeserverUrl(e.currentTarget.value)}
            disabled={pending}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="username">Username</Label>
          <Input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
            placeholder="Username"
            aria-invalid={Boolean(error)}
            disabled={pending}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            placeholder="Password"
            aria-invalid={Boolean(error)}
            disabled={pending}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <Button type="submit" disabled={pending} className="w-full">
          {pending && <Loader2 className="animate-spin" />}
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
