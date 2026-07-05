import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { completeSsoLogin, login, register, startSsoLogin, type LoginResponse } from "@/lib/matrix";
import { useHomeserverDiscovery } from "./useHomeserverDiscovery";

const SSO_CALLBACK_PREFIX = "charm://sso-callback";

interface LoginScreenProps {
  onSignedIn: (session: LoginResponse) => void;
}

type Mode = "sign-in" | "register";

export function LoginScreen({ onSignedIn }: LoginScreenProps) {
  const [mode, setMode] = useState<Mode>("sign-in");
  // Must include the scheme: server_name_or_homeserver_url treats a bare
  // "host:port" as a server name and attempts HTTPS discovery against it,
  // which hangs against our plain-HTTP local dev Synapse.
  const [homeserverUrl, setHomeserverUrl] = useState("http://localhost:8008");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const discovery = useHomeserverDiscovery(homeserverUrl);

  // Guards against acting on the same charm://sso-callback URL twice (the
  // deep-link plugin can, in principle, deliver it more than once) and
  // against completing a callback that doesn't belong to an SSO attempt this
  // screen actually started.
  const ssoInProgressRef = useRef(false);

  useEffect(() => {
    const unlisten = onOpenUrl((urls) => {
      const callbackUrl = urls.find((url) => url.startsWith(SSO_CALLBACK_PREFIX));
      if (!callbackUrl || !ssoInProgressRef.current) return;
      ssoInProgressRef.current = false;

      completeSsoLogin(callbackUrl)
        .then(onSignedIn)
        .catch((err: unknown) => setError(String(err)))
        .finally(() => setPending(false));
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [onSignedIn]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response =
        mode === "sign-in"
          ? await login({ homeserver_url: homeserverUrl, username, password })
          : await register({ homeserver_url: homeserverUrl, username, password });
      onSignedIn(response);
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(false);
    }
  }

  async function handleSsoLogin() {
    setPending(true);
    setError(null);
    try {
      const ssoUrl = await startSsoLogin(homeserverUrl);
      ssoInProgressRef.current = true;
      await openUrl(ssoUrl);
      // Left pending: resolved by the onOpenUrl listener above once the
      // system browser redirects back with charm://sso-callback.
    } catch (err) {
      setError(String(err));
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="flex w-90 flex-col gap-5">
        <div className="flex flex-col gap-1 text-center">
          <h1 className="text-xl font-bold text-foreground">Charm</h1>
          <p className="text-sm text-muted-foreground">Sign in to your homeserver</p>
        </div>

        <Tabs
          value={mode}
          onValueChange={(value) => {
            setMode(value as Mode);
            setError(null);
          }}
        >
          <TabsList className="w-full">
            <TabsTrigger value="sign-in">Sign in</TabsTrigger>
            <TabsTrigger value="register">Create account</TabsTrigger>
          </TabsList>

          <TabsContent value={mode}>
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="homeserver-url">Homeserver</Label>
                <Input
                  id="homeserver-url"
                  value={homeserverUrl}
                  onChange={(e) => setHomeserverUrl(e.currentTarget.value)}
                  placeholder="matrix.org"
                  disabled={pending}
                />
                <p className="text-xs text-muted-foreground">
                  {discovery.state === "resolving" && "Looking up server…"}
                  {discovery.state === "resolved" && `Resolved to ${discovery.homeserverUrl}`}
                  {discovery.state === "failed" && "Could not find a homeserver at that address"}
                  {discovery.state === "idle" && "Server name (matrix.org) or full URL"}
                </p>
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
                {pending
                  ? mode === "sign-in"
                    ? "Signing in…"
                    : "Creating account…"
                  : mode === "sign-in"
                    ? "Sign in"
                    : "Create account"}
              </Button>

              {mode === "sign-in" && (
                <>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <div className="h-px flex-1 bg-border" />
                    or
                    <div className="h-px flex-1 bg-border" />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={handleSsoLogin}
                    className="w-full"
                  >
                    Continue with SSO
                  </Button>
                </>
              )}
            </form>
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}
