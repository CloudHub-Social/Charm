import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  beginRegistration,
  cancelPasswordReset,
  cancelRegistration,
  cancelSsoLogin,
  confirmPasswordReset,
  completeSsoLogin,
  continueRegistration,
  getLoginFlows,
  login,
  loginWithToken,
  requestRegistrationEmail,
  requestPasswordReset,
  register,
  startSsoLogin,
  type LoginResponse,
  type LoginFlowSummary,
  type PasswordResetChallenge,
  type RegistrationAuthResponse,
  type RegistrationEmailChallenge,
  type RegistrationStep,
} from "@/lib/matrix";
import { useFeatureFlagsInitialized, useFlag } from "@/featureFlags";
import { QrLoginScreen } from "./QrLoginScreen";
import { useHomeserverDiscovery } from "./useHomeserverDiscovery";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { openExternalUrl } from "@/lib/openExternalUrl";
import { isWebBuild } from "@/lib/platform";

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
  const [homeserverUrl, setHomeserverUrl] = useState(
    // `||`, not `??`: an unset var is `undefined`, but a `.env` file that
    // defines the key with an empty value (common when it's left blank
    // rather than omitted) resolves to `""`, which `??` would treat as a
    // real override and leave the field blank instead of falling back.
    import.meta.env.VITE_CHARM_DEFAULT_HOMESERVER_URL || "https://cloudhub.social",
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [registrationStep, setRegistrationStep] = useState<
    Extract<RegistrationStep, { state: "challenge" }> | undefined
  >();
  const [registrationEmail, setRegistrationEmail] = useState("");
  const [registrationEmailToken, setRegistrationEmailToken] = useState("");
  const [registrationEmailChallenge, setRegistrationEmailChallenge] =
    useState<RegistrationEmailChallenge>();
  const [loginFlows, setLoginFlows] = useState<LoginFlowSummary>();
  const [loginFlowsFailed, setLoginFlowsFailed] = useState(false);
  const [showTokenLogin, setShowTokenLogin] = useState(false);
  const [loginToken, setLoginToken] = useState("");
  const [showPasswordReset, setShowPasswordReset] = useState(false);
  const [passwordResetChallenge, setPasswordResetChallenge] = useState<PasswordResetChallenge>();
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [recoveryToken, setRecoveryToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordResetComplete, setPasswordResetComplete] = useState(false);
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
  const showNativeSignInOptions = !isWebBuild();
  const registrationUiaEnabled = useFlag("registration_and_recovery") && !isWebBuild();
  const featureFlagsInitialized = useFeatureFlagsInitialized();
  const passwordLoginAvailable =
    !registrationUiaEnabled || loginFlows === undefined || loginFlowsFailed || loginFlows.password;
  const showGenericSso =
    !registrationUiaEnabled ||
    loginFlows === undefined ||
    loginFlowsFailed ||
    (loginFlows.sso && loginFlows.identity_providers.length === 0);

  const discovery = useHomeserverDiscovery(homeserverUrl);

  useEffect(() => {
    if (!registrationUiaEnabled || mode !== "sign-in" || discovery.state !== "resolved") {
      setLoginFlows(undefined);
      setLoginFlowsFailed(discovery.state === "failed");
      return undefined;
    }
    let current = true;
    setLoginFlows(undefined);
    setLoginFlowsFailed(false);
    getLoginFlows(discovery.homeserverUrl)
      .then((flows) => {
        if (current) {
          setLoginFlows(flows);
          setLoginFlowsFailed(false);
        }
      })
      .catch(() => {
        if (current) {
          setLoginFlows(undefined);
          setLoginFlowsFailed(true);
        }
      });
    return () => {
      current = false;
    };
  }, [discovery, mode, registrationUiaEnabled]);

  useEffect(() => {
    // A token is a homeserver-scoped bearer credential. Clear it as soon as
    // discovery restarts so a value entered for server A can never be sent
    // to server B while B's capabilities are still loading.
    if (!registrationUiaEnabled || !loginFlows?.token) {
      setShowTokenLogin(false);
      setLoginToken("");
    }
  }, [loginFlows, registrationUiaEnabled]);

  // Guards against acting on the same charm://sso-callback URL twice (the
  // deep-link plugin can, in principle, deliver it more than once) and
  // against completing a callback that doesn't belong to an SSO attempt this
  // screen actually started (e.g. one the user already cancelled).
  const ssoInProgressRef = useRef(false);
  const ssoOperationRef = useRef(0);
  // Keeps cancellation from exposing the SSO buttons while the backend is
  // still creating an attempt. Once that setup settles, its stale-operation
  // branch cancels the exact pending attempt before allowing another start.
  const ssoSetupInFlightRef = useRef(false);
  const registrationAttemptRef = useRef<string | null>(null);
  const registrationEmailOperationRef = useRef(0);
  const passwordResetAttemptRef = useRef<string | null>(null);
  const passwordResetOperationRef = useRef(0);
  const passwordResetCancellationRef = useRef<Promise<void> | undefined>(undefined);

  useEffect(
    () => () => {
      const attemptId = registrationAttemptRef.current;
      registrationAttemptRef.current = null;
      registrationEmailOperationRef.current += 1;
      if (attemptId) cancelRegistration(attemptId).catch(logAndIgnore);
      const resetAttemptId = passwordResetAttemptRef.current;
      passwordResetAttemptRef.current = null;
      passwordResetOperationRef.current += 1;
      if (resetAttemptId) cancelPasswordReset(resetAttemptId).catch(logAndIgnore);
    },
    [],
  );

  useEffect(() => {
    if (isWebBuild()) return undefined;

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
      // Deliberately silent (not logAndIgnore): failing here just means "no
      // cold-launch deep link was pending" (e.g. plain cold start with no
      // SSO in flight), which is the overwhelmingly common case — logging it
      // would be console noise on every normal app launch, not a real error.
      .catch(() => {});

    const unlisten = onOpenUrl((urls) => {
      const callbackUrl = urls.find((url) => SSO_CALLBACK_URL_PATTERN.test(url));
      if (!callbackUrl || !ssoInProgressRef.current) return;
      tryCompleteSsoCallback(callbackUrl);
    });

    return () => {
      unlisten.then((fn) => fn()).catch(logAndIgnore);
    };
  }, [onSignedIn]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "register" && !featureFlagsInitialized) return;
    setPending(true);
    setError(null);
    try {
      if (mode === "sign-in") {
        if (showTokenLogin) {
          if (discovery.state !== "resolved" || !loginFlows?.token) {
            throw new Error("Token login options changed; re-enter the token.");
          }
          onSignedIn(await loginWithToken(discovery.homeserverUrl, loginToken));
          setLoginToken("");
        } else {
          if (discovery.state === "resolved" && !loginFlows?.password) {
            throw new Error("This homeserver does not offer password sign-in.");
          }
          onSignedIn(await login({ homeserver_url: homeserverUrl, username, password }));
        }
      } else if (registrationUiaEnabled) {
        await handleRegistrationStep(
          await beginRegistration({ homeserver_url: homeserverUrl, username, password }),
        );
      } else {
        onSignedIn(await register({ homeserver_url: homeserverUrl, username, password }));
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(false);
    }
  }

  async function handleRegistrationStep(initialStep: RegistrationStep, expectedOperation?: number) {
    let step = initialStep;
    try {
      for (let automaticStages = 0; step.state === "challenge"; automaticStages += 1) {
        if (
          expectedOperation !== undefined &&
          registrationEmailOperationRef.current !== expectedOperation
        ) {
          return;
        }
        registrationAttemptRef.current = step.attempt_id;
        if (step.next_stage !== "m.login.dummy") break;
        if (automaticStages >= 8) {
          throw new Error("Homeserver repeated an automatic registration stage; start again.");
        }
        // UIA stages are ordered and stateful, so each automatic dummy response
        // must use the challenge returned by the previous request.
        // oxlint-disable-next-line no-await-in-loop
        step = await continueRegistration(step.attempt_id, { kind: "complete_dummy" });
      }
    } catch (error) {
      const attemptId = registrationAttemptRef.current;
      registrationAttemptRef.current = null;
      setRegistrationStep(undefined);
      if (attemptId) await cancelRegistration(attemptId).catch(logAndIgnore);
      throw error;
    }
    if (
      expectedOperation !== undefined &&
      registrationEmailOperationRef.current !== expectedOperation
    ) {
      return;
    }
    if (step.state === "complete") {
      registrationAttemptRef.current = null;
      setRegistrationStep(undefined);
      setRegistrationEmailChallenge(undefined);
      setRegistrationEmailToken("");
      setPassword("");
      onSignedIn(step.session);
      return;
    }
    if (step.next_stage !== "m.login.email.identity") {
      setRegistrationEmailChallenge(undefined);
      setRegistrationEmailToken("");
    }
    setRegistrationStep(step);
    setPassword("");
  }

  async function handleRequestRegistrationEmail() {
    const attemptId = registrationAttemptRef.current;
    if (!attemptId || !registrationEmail) return;
    const operation = ++registrationEmailOperationRef.current;
    setPending(true);
    setError(null);
    try {
      const challenge = await requestRegistrationEmail(attemptId, registrationEmail);
      if (
        registrationEmailOperationRef.current === operation &&
        registrationAttemptRef.current === attemptId
      ) {
        setRegistrationEmailChallenge(challenge);
      }
    } catch (err) {
      if (registrationEmailOperationRef.current === operation) {
        const message = String(err);
        if (message.includes("registration ended:")) {
          registrationAttemptRef.current = null;
          setRegistrationStep(undefined);
        }
        setError(message.replace("registration ended:", "").trim());
      }
    } finally {
      if (registrationEmailOperationRef.current === operation) setPending(false);
    }
  }

  async function handleRegistrationContinue(response: RegistrationAuthResponse) {
    const attemptId = registrationAttemptRef.current;
    if (!attemptId) return;
    const operation = ++registrationEmailOperationRef.current;
    setPending(true);
    setError(null);
    try {
      const step = await continueRegistration(attemptId, response);
      if (
        registrationEmailOperationRef.current !== operation ||
        registrationAttemptRef.current !== attemptId
      ) {
        return;
      }
      await handleRegistrationStep(step, operation);
    } catch (err) {
      if (registrationEmailOperationRef.current === operation) setError(String(err));
    } finally {
      if (registrationEmailOperationRef.current === operation) setPending(false);
    }
  }

  async function handleCancelRegistration() {
    const attemptId = registrationAttemptRef.current;
    registrationAttemptRef.current = null;
    registrationEmailOperationRef.current += 1;
    if (attemptId) await cancelRegistration(attemptId).catch(logAndIgnore);
    setRegistrationStep(undefined);
    setRegistrationEmailChallenge(undefined);
    setRegistrationEmail("");
    setRegistrationEmailToken("");
    setPending(false);
    setError(null);
  }

  async function handleOpenRegistrationUrl(url: string) {
    setError(null);
    try {
      await openExternalUrl(url);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleSsoLogin(idpId?: string) {
    const operation = ++ssoOperationRef.current;
    ssoSetupInFlightRef.current = true;
    setSsoPending(true);
    setError(null);
    try {
      const ssoUrl = await startSsoLogin(homeserverUrl, idpId);
      ssoSetupInFlightRef.current = false;
      if (operation !== ssoOperationRef.current) {
        await cancelSsoLogin().catch(logAndIgnore);
        setSsoPending(false);
        return;
      }
      ssoInProgressRef.current = true;
      await openExternalUrl(ssoUrl);
      // Left pending: resolved by the onOpenUrl listener above once the
      // system browser redirects back with charm://sso-callback, or by
      // handleCancelSso if the user gives up and comes back without it.
    } catch (err) {
      ssoSetupInFlightRef.current = false;
      if (operation !== ssoOperationRef.current) {
        setSsoPending(false);
        return;
      }
      ssoInProgressRef.current = false;
      setError(String(err));
      setSsoPending(false);
    }
  }

  function handleCancelSso() {
    ssoOperationRef.current += 1;
    ssoInProgressRef.current = false;
    // If setup is still in flight, keep the controls disabled. The stale
    // setup branch above performs a second cancellation after the backend
    // has actually installed its pending attempt, then clears this state.
    if (!ssoSetupInFlightRef.current) setSsoPending(false);
    setError(null);
    // Releases the client start_sso_login left pending on the Rust side
    // (its SQLite connection and HTTP pool) — best-effort, since the UI has
    // already moved on regardless of whether this succeeds.
    cancelSsoLogin().catch(logAndIgnore);
  }

  async function handleRequestPasswordReset(e: React.FormEvent) {
    e.preventDefault();
    const operation = ++passwordResetOperationRef.current;
    if (passwordResetCancellationRef.current) {
      await passwordResetCancellationRef.current;
    }
    if (passwordResetOperationRef.current !== operation) return;
    setPending(true);
    setError(null);
    let challenge: PasswordResetChallenge;
    try {
      challenge = await requestPasswordReset(homeserverUrl, recoveryEmail);
    } catch {
      // The backend deliberately maps homeserver responses to a single
      // account-independent error. Preserve that privacy boundary while
      // still surfacing connection/configuration failures as actionable.
      if (passwordResetOperationRef.current === operation) {
        setError(
          "Could not start password reset. Check your connection and homeserver settings, then try again.",
        );
      }
      return;
    } finally {
      if (passwordResetOperationRef.current === operation) setPending(false);
    }
    if (passwordResetOperationRef.current !== operation) {
      if (!challenge.attempt_id.startsWith("unavailable-")) {
        cancelPasswordReset(challenge.attempt_id).catch(logAndIgnore);
      }
      return;
    }
    passwordResetAttemptRef.current = challenge.attempt_id;
    setPasswordResetChallenge(challenge);
  }

  async function handleConfirmPasswordReset(e: React.FormEvent) {
    e.preventDefault();
    const attemptId = passwordResetAttemptRef.current;
    if (!attemptId) return;
    const operation = ++passwordResetOperationRef.current;
    setPending(true);
    setError(null);
    try {
      await confirmPasswordReset(attemptId, recoveryToken || undefined, newPassword);
      if (passwordResetOperationRef.current !== operation) return;
      passwordResetAttemptRef.current = null;
      setRecoveryToken("");
      setNewPassword("");
      setPassword("");
      setPasswordResetComplete(true);
    } catch {
      if (passwordResetOperationRef.current === operation) {
        setError(
          "Password reset could not be confirmed. Verify the email step and new password, then try again.",
        );
      }
    } finally {
      if (passwordResetOperationRef.current === operation) setPending(false);
    }
  }

  function closePasswordReset() {
    passwordResetOperationRef.current += 1;
    const attemptId = passwordResetAttemptRef.current;
    passwordResetAttemptRef.current = null;
    const cancellation = cancelPasswordReset(attemptId ?? undefined).catch(logAndIgnore);
    passwordResetCancellationRef.current = cancellation;
    void cancellation.finally(() => {
      if (passwordResetCancellationRef.current === cancellation) {
        passwordResetCancellationRef.current = undefined;
      }
    });
    setShowPasswordReset(false);
    setPasswordResetChallenge(undefined);
    setPasswordResetComplete(false);
    setRecoveryEmail("");
    setRecoveryToken("");
    setNewPassword("");
    setPending(false);
    setError(null);
  }

  return (
    <main className="flex min-h-[100dvh] items-center justify-center p-4 sm:p-8">
      <div className="flex w-full max-w-90 flex-col gap-5">
        <div className="flex flex-col gap-1 text-center">
          <h1 className="text-xl font-bold text-foreground">Charm</h1>
          <p className="text-sm text-muted-foreground">Sign in to your homeserver</p>
        </div>

        {showPasswordReset ? (
          <div className="flex flex-col gap-5">
            {passwordResetComplete ? (
              <div className="flex flex-col gap-4" aria-live="polite">
                <div className="flex flex-col gap-1">
                  <h2 className="text-sm font-semibold">Password updated</h2>
                  <p className="text-xs text-muted-foreground">
                    You can now sign in with your new password.
                  </p>
                </div>
                <Button type="button" onClick={closePasswordReset}>
                  Return to sign in
                </Button>
              </div>
            ) : passwordResetChallenge ? (
              <form className="flex flex-col gap-4" onSubmit={handleConfirmPasswordReset}>
                <div className="flex flex-col gap-1">
                  <h2 className="text-sm font-semibold">Set a new password</h2>
                  <p className="text-xs text-muted-foreground">
                    Follow the instructions in your email. If it includes a token, enter it below.
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="recovery-token">Email token (if provided)</Label>
                  <Input
                    id="recovery-token"
                    value={recoveryToken}
                    onChange={(event) => setRecoveryToken(event.currentTarget.value)}
                    autoComplete="one-time-code"
                    disabled={pending}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="new-password">New password</Label>
                  <Input
                    id="new-password"
                    type="password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.currentTarget.value)}
                    autoComplete="new-password"
                    disabled={pending}
                    required
                  />
                </div>
                {error && <p className="text-xs text-destructive">{error}</p>}
                <Button type="submit" disabled={pending}>
                  {pending && <Loader2 className="animate-spin" />}
                  Reset password
                </Button>
                <Button type="button" variant="ghost" onClick={closePasswordReset}>
                  Cancel
                </Button>
              </form>
            ) : (
              <form className="flex flex-col gap-4" onSubmit={handleRequestPasswordReset}>
                <div className="flex flex-col gap-1">
                  <h2 className="text-sm font-semibold">Reset your password</h2>
                  <p className="text-xs text-muted-foreground">
                    We’ll ask your homeserver to send recovery instructions. The response stays
                    deliberately generic.
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="recovery-homeserver">Homeserver</Label>
                  <Input
                    id="recovery-homeserver"
                    value={homeserverUrl}
                    onChange={(event) => setHomeserverUrl(event.currentTarget.value)}
                    disabled={pending}
                    required
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="recovery-email">Email</Label>
                  <Input
                    id="recovery-email"
                    type="email"
                    value={recoveryEmail}
                    onChange={(event) => setRecoveryEmail(event.currentTarget.value)}
                    autoComplete="email"
                    disabled={pending}
                    required
                  />
                </div>
                {error && <p className="text-xs text-destructive">{error}</p>}
                <Button type="submit" disabled={pending}>
                  {pending && <Loader2 className="animate-spin" />}
                  Send recovery email
                </Button>
                <Button type="button" variant="ghost" onClick={closePasswordReset}>
                  Cancel
                </Button>
              </form>
            )}
          </div>
        ) : showQrLogin ? (
          <QrLoginScreen
            homeserverUrl={homeserverUrl}
            onSignedIn={onSignedIn}
            onCancel={() => setShowQrLogin(false)}
          />
        ) : (
          <Tabs
            value={mode}
            onValueChange={(value) => {
              void (async () => {
                if (registrationStep) await handleCancelRegistration();
                setMode(value as Mode);
                setShowTokenLogin(false);
                setLoginToken("");
                setError(null);
                if (ssoPending) handleCancelSso();
              })();
            }}
          >
            <TabsList className="w-full">
              <TabsTrigger value="sign-in" disabled={pending || ssoPending}>
                Sign in
              </TabsTrigger>
              <TabsTrigger value="register" disabled={pending || ssoPending}>
                Create account
              </TabsTrigger>
            </TabsList>

            <TabsContent value={mode}>
              {mode === "register" && registrationStep ? (
                <div className="flex flex-col gap-5" aria-live="polite">
                  <div className="flex flex-col gap-1">
                    <h2 className="text-sm font-semibold">Finish creating your account</h2>
                    <p className="text-xs text-muted-foreground">
                      {registrationStageDescription(registrationStep.next_stage)}
                    </p>
                  </div>

                  {registrationStep.next_stage === "m.login.terms" && (
                    <div className="flex flex-col gap-3">
                      {registrationStep.policies.length > 0 && (
                        <div className="flex flex-col gap-2">
                          {registrationStep.policies.map((policy) => (
                            <Button
                              key={`${policy.id}:${policy.language}`}
                              type="button"
                              variant="outline"
                              onClick={() => void handleOpenRegistrationUrl(policy.url)}
                            >
                              Read {policy.name}
                            </Button>
                          ))}
                        </div>
                      )}
                      <Button
                        type="button"
                        disabled={pending}
                        onClick={() => void handleRegistrationContinue({ kind: "accept_terms" })}
                      >
                        {pending && <Loader2 className="animate-spin" />}
                        Accept and continue
                      </Button>
                      {registrationStep.policies.length === 0 && (
                        <p role="alert" className="text-xs text-destructive">
                          This homeserver did not provide terms that Charm can display. Cancel and
                          use the homeserver's registration page.
                        </p>
                      )}
                    </div>
                  )}

                  {registrationStep.next_stage === "m.login.email.identity" && (
                    <div className="flex flex-col gap-3">
                      {!registrationEmailChallenge ? (
                        <>
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor="registration-email">Email</Label>
                            <Input
                              id="registration-email"
                              type="email"
                              value={registrationEmail}
                              onChange={(event) => setRegistrationEmail(event.currentTarget.value)}
                              autoComplete="email"
                              disabled={pending}
                            />
                          </div>
                          <Button
                            type="button"
                            disabled={pending || !registrationEmail}
                            onClick={() => void handleRequestRegistrationEmail()}
                          >
                            {pending && <Loader2 className="animate-spin" />}
                            Send verification email
                          </Button>
                        </>
                      ) : (
                        <>
                          {registrationEmailChallenge.requires_token ? (
                            <div className="flex flex-col gap-1.5">
                              <Label htmlFor="registration-email-token">Email token</Label>
                              <Input
                                id="registration-email-token"
                                value={registrationEmailToken}
                                onChange={(event) =>
                                  setRegistrationEmailToken(event.currentTarget.value)
                                }
                                autoComplete="one-time-code"
                                disabled={pending}
                              />
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              Open the link in the verification email, then return here.
                            </p>
                          )}
                          <Button
                            type="button"
                            disabled={
                              pending ||
                              (registrationEmailChallenge.requires_token && !registrationEmailToken)
                            }
                            onClick={() =>
                              void handleRegistrationContinue({
                                kind: "complete_email",
                                token: registrationEmailChallenge.requires_token
                                  ? registrationEmailToken
                                  : null,
                              })
                            }
                          >
                            {pending && <Loader2 className="animate-spin" />}
                            Complete email verification
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            disabled={pending}
                            onClick={() => void handleRequestRegistrationEmail()}
                          >
                            Resend verification email
                          </Button>
                          <p className="text-xs text-muted-foreground">
                            To use a different email address, cancel this registration and start
                            again.
                          </p>
                        </>
                      )}
                    </div>
                  )}

                  {registrationStep.next_stage !== "m.login.terms" &&
                    registrationStep.next_stage !== "m.login.email.identity" &&
                    registrationStep.next_stage !== "m.login.dummy" && (
                      <div className="flex flex-col gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          disabled={pending}
                          onClick={() =>
                            void handleOpenRegistrationUrl(registrationStep.fallback_url)
                          }
                        >
                          Open verification
                        </Button>
                        <Button
                          type="button"
                          disabled={pending}
                          onClick={() =>
                            void handleRegistrationContinue({
                              kind: "acknowledge_fallback",
                              stage: registrationStep.next_stage,
                            })
                          }
                        >
                          {pending && <Loader2 className="animate-spin" />}
                          I have completed verification
                        </Button>
                      </div>
                    )}

                  {error && <p className="text-xs text-destructive">{error}</p>}
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => void handleCancelRegistration()}
                  >
                    Cancel account creation
                  </Button>
                </div>
              ) : (
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
                      {discovery.state === "failed" &&
                        "Could not find a homeserver at that address"}
                      {discovery.state === "idle" && "Server name (matrix.org) or full URL"}
                    </p>
                  </div>

                  {mode === "sign-in" && showTokenLogin ? (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="login-token">Login token</Label>
                      <Input
                        id="login-token"
                        type="password"
                        value={loginToken}
                        onChange={(e) => setLoginToken(e.currentTarget.value)}
                        placeholder="Paste login token"
                        autoComplete="off"
                        aria-invalid={Boolean(error)}
                        disabled={pending || ssoPending}
                      />
                      <p className="text-xs text-muted-foreground">
                        Tokens are used once and are never saved by Charm.
                      </p>
                    </div>
                  ) : passwordLoginAvailable || mode === "register" ? (
                    <>
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
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      This homeserver does not offer password sign-in. Choose one of its sign-in
                      options below.
                    </p>
                  )}
                  {error && <p className="text-xs text-destructive">{error}</p>}

                  {(mode === "register" || showTokenLogin || passwordLoginAvailable) && (
                    <Button
                      type="submit"
                      disabled={
                        pending || ssoPending || (mode === "register" && !featureFlagsInitialized)
                      }
                      className="w-full"
                    >
                      {pending && <Loader2 className="animate-spin" />}
                      {pending
                        ? mode === "sign-in"
                          ? showTokenLogin
                            ? "Using token…"
                            : "Signing in…"
                          : "Creating account…"
                        : mode === "sign-in"
                          ? showTokenLogin
                            ? "Use login token"
                            : "Sign in"
                          : "Create account"}
                    </Button>
                  )}

                  {mode === "sign-in" &&
                    registrationUiaEnabled &&
                    loginFlows?.password === true &&
                    !showTokenLogin && (
                      <Button
                        type="button"
                        variant="link"
                        disabled={pending || ssoPending}
                        onClick={() => {
                          setPassword("");
                          setShowPasswordReset(true);
                          setError(null);
                        }}
                        className="w-full"
                      >
                        Forgot password?
                      </Button>
                    )}

                  {mode === "sign-in" && showNativeSignInOptions && (
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
                          {showGenericSso && (
                            <Button
                              type="button"
                              variant="outline"
                              disabled={pending}
                              onClick={() => void handleSsoLogin()}
                              className="w-full"
                            >
                              Continue with SSO
                            </Button>
                          )}
                          {registrationUiaEnabled &&
                            loginFlows?.identity_providers.map((provider) => (
                              <Button
                                key={provider.id}
                                type="button"
                                variant="outline"
                                disabled={pending}
                                onClick={() => void handleSsoLogin(provider.id)}
                                className="w-full"
                              >
                                Continue with {provider.name}
                              </Button>
                            ))}
                          {registrationUiaEnabled && loginFlows?.token && (
                            <Button
                              type="button"
                              variant="outline"
                              disabled={pending}
                              onClick={() => {
                                setShowTokenLogin((current) => !current);
                                setLoginToken("");
                                setError(null);
                              }}
                              className="w-full"
                            >
                              {showTokenLogin ? "Use password instead" : "Use a login token"}
                            </Button>
                          )}
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
              )}
            </TabsContent>
          </Tabs>
        )}
      </div>
    </main>
  );
}

function registrationStageDescription(stage: string): string {
  switch (stage) {
    case "m.login.terms":
      return "Review and accept the homeserver policies to continue.";
    case "m.login.dummy":
      return "Your homeserver is ready to finish registration.";
    case "m.login.recaptcha":
      return "Complete the homeserver CAPTCHA in your browser, then return to Charm.";
    case "m.login.email.identity":
      return "Verify your email through the homeserver, then return to Charm.";
    default:
      return "Complete this homeserver verification step in your browser, then return to Charm.";
  }
}
