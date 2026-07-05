import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  cancelSsoLogin,
  completeSsoLogin,
  login,
  register,
  startSsoLogin,
  type LoginResponse,
} from "@/lib/matrix";
import { QrLoginScreen } from "./QrLoginScreen";
import { useHomeserverDiscovery } from "./useHomeserverDiscovery";

// Anchored so "charm://sso-callback-evil" or "charm://sso-callback.evil.com"
// can't slip past a plain `startsWith` check.
const SSO_CALLBACK_URL_PATTERN = /^charm:\/\/sso-callback(?:\?|$)/;

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
  // Separate from `pending`: true from the moment the browser is opened
  // until the charm://sso-callback deep link arrives (or the user cancels).
  // Distinct because there's no way to know if/when the user will finish in
  // the browser, so — unlike `pending` for the password form, which always
  // resolves on its own — this state needs a manual way out.
  const [ssoPending, setSsoPending] = useState(false);
  // Separate screen entirely, not another Mode: QR login has its own
  // multi-stage lifecycle (generating, waiting for scan, check code,
  // approval, syncing secrets) that doesn't fit the sign-in/register form.
  const [showQrLogin, setShowQrLogin] = useState(false);

  const discovery = useHomeserverDiscovery(homeserverUrl);

  // Guards against acting on the same charm://sso-callback URL twice (the
  // deep-link plugin can, in principle, deliver it more than once) and
  // against completing a callback that doesn't belong to an SSO attempt this
  // screen actually started (e.g. one the user already cancelled).
  const ssoInProgressRef = useRef(false);

  useEffect(() => {
    // Shared by both the cold-launch check and the warm onOpenUrl listener
    // below. On a cold launch (app was fully closed during the browser step,
    // then relaunched by the OS via the redirect), there's no in-memory
    // ssoInProgressRef/pending_sso to resume — this process is brand new —
    // so completeSsoLogin will fail with "no SSO login is in progress"
    // rather than silently doing nothing, which at least tells the user to
    // retry instead of leaving them stuck on a login screen with no signal.
    function tryCompleteSsoCallback(callbackUrl: string) {
      ssoInProgressRef.current = false;
      setSsoPending(true);
      completeSsoLogin(callbackUrl)
        .then(onSignedIn)
        .catch((err: unknown) => setError(String(err)))
        .finally(() => setSsoPending(false));
    }

    // Cold launch: the deep link that started this process, if any — only
    // relevant if the app was closed and relaunched by the OS mid-flow
    // (see tryCompleteSsoCallback), since the normal case (app stayed open
    // through the whole SSO round trip) is handled by onOpenUrl below.
    getCurrent()
      .then((urls) => urls?.find((url) => SSO_CALLBACK_URL_PATTERN.test(url)))
      .then((callbackUrl) => {
        if (callbackUrl) tryCompleteSsoCallback(callbackUrl);
      })
      .catch(() => {});

    const unlisten = onOpenUrl((urls) => {
      const callbackUrl = urls.find((url) => SSO_CALLBACK_URL_PATTERN.test(url));
      if (!callbackUrl || !ssoInProgressRef.current) return;
      tryCompleteSsoCallback(callbackUrl);
    });

    return () => {
      unlisten.then((fn) => fn()).catch(console.error);
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
    setSsoPending(true);
    setError(null);
    try {
      const ssoUrl = await startSsoLogin(homeserverUrl);
      ssoInProgressRef.current = true;
      await openUrl(ssoUrl);
      // Left pending: resolved by the onOpenUrl listener above once the
      // system browser redirects back with charm://sso-callback, or by
      // handleCancelSso if the user gives up and comes back without it.
    } catch (err) {
      ssoInProgressRef.current = false;
      setError(String(err));
      setSsoPending(false);
    }
  }

  function handleCancelSso() {
    ssoInProgressRef.current = false;
    setSsoPending(false);
    setError(null);
    // Releases the client start_sso_login left pending on the Rust side
    // (its SQLite connection and HTTP pool) — best-effort, since the UI has
    // already moved on regardless of whether this succeeds.
    cancelSsoLogin().catch(console.error);
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="flex w-90 flex-col gap-5">
        <div className="flex flex-col gap-1 text-center">
          <h1 className="text-xl font-bold text-foreground">Charm</h1>
          <p className="text-sm text-muted-foreground">Sign in to your homeserver</p>
        </div>

        {showQrLogin ? (
          <QrLoginScreen
            homeserverUrl={homeserverUrl}
            onSignedIn={onSignedIn}
            onCancel={() => setShowQrLogin(false)}
          />
        ) : (
          <Tabs
            value={mode}
            onValueChange={(value) => {
              setMode(value as Mode);
              setError(null);
              if (ssoPending) handleCancelSso();
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
                    disabled={pending || ssoPending}
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
                    disabled={pending || ssoPending}
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
                    disabled={pending || ssoPending}
                  />
                  {error && <p className="text-xs text-destructive">{error}</p>}
                </div>

                <Button type="submit" disabled={pending || ssoPending} className="w-full">
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
                    {ssoPending ? (
                      <div className="flex flex-col gap-2">
                        <p className="text-center text-xs text-muted-foreground">
                          Waiting for you to finish in the browser…
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={handleCancelSso}
                          className="w-full"
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          disabled={pending}
                          onClick={handleSsoLogin}
                          className="w-full"
                        >
                          Continue with SSO
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={pending}
                          onClick={() => setShowQrLogin(true)}
                          className="w-full"
                        >
                          Sign in with QR code
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </form>
            </TabsContent>
          </Tabs>
        )}
      </div>
    </main>
  );
}
