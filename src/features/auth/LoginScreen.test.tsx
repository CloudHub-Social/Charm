import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginScreen } from "./LoginScreen";
import type { LoginResponse, PasswordResetChallenge } from "@/lib/matrix";

let getCurrentUrls: string[] | null = null;
let openUrlCallback: ((urls: string[]) => void) | undefined;

const getCurrent = vi.fn(async () => getCurrentUrls);
const onOpenUrl = vi.fn((callback: (urls: string[]) => void) => {
  openUrlCallback = callback;
  return Promise.resolve(() => {});
});
const openUrl = vi.fn().mockResolvedValue(undefined);

const login = vi.fn();
const register = vi.fn();
const beginRegistration = vi.fn();
const requestRegistrationEmail = vi.fn();
const continueRegistration = vi.fn();
const cancelRegistration = vi.fn().mockResolvedValue(undefined);
const getLoginFlows = vi.fn().mockResolvedValue({
  password: true,
  token: false,
  sso: true,
  identity_providers: [],
});
const loginWithToken = vi.fn();
const requestPasswordReset = vi.fn();
const confirmPasswordReset = vi.fn();
const cancelPasswordReset = vi.fn().mockResolvedValue(undefined);
const startSsoLogin = vi.fn().mockResolvedValue("https://homeserver.example/sso");
const completeSsoLogin = vi.fn();
const cancelSsoLogin = vi.fn().mockResolvedValue(undefined);
const discoverHomeserver = vi.fn().mockReturnValue(new Promise(() => {}));
const featureFlags = vi.hoisted(() => ({ registrationEnabled: false, initialized: true }));

vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: () => getCurrent(),
  onOpenUrl: (callback: (urls: string[]) => void) => onOpenUrl(callback),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

vi.mock("@/lib/matrix", () => ({
  login: (...args: unknown[]) => login(...args),
  register: (...args: unknown[]) => register(...args),
  beginRegistration: (...args: unknown[]) => beginRegistration(...args),
  requestRegistrationEmail: (...args: unknown[]) => requestRegistrationEmail(...args),
  continueRegistration: (...args: unknown[]) => continueRegistration(...args),
  cancelRegistration: (...args: unknown[]) => cancelRegistration(...args),
  getLoginFlows: (...args: unknown[]) => getLoginFlows(...args),
  loginWithToken: (...args: unknown[]) => loginWithToken(...args),
  requestPasswordReset: (...args: unknown[]) => requestPasswordReset(...args),
  confirmPasswordReset: (...args: unknown[]) => confirmPasswordReset(...args),
  cancelPasswordReset: (...args: unknown[]) => cancelPasswordReset(...args),
  startSsoLogin: (...args: unknown[]) => startSsoLogin(...args),
  completeSsoLogin: (...args: unknown[]) => completeSsoLogin(...args),
  cancelSsoLogin: (...args: unknown[]) => cancelSsoLogin(...args),
  discoverHomeserver: (...args: unknown[]) => discoverHomeserver(...args),
}));

vi.mock("@/featureFlags", () => ({
  useFlag: (key: string) => key === "registration_and_recovery" && featureFlags.registrationEnabled,
  useFeatureFlagsInitialized: () => featureFlags.initialized,
}));

vi.mock("./QrLoginScreen", () => ({
  QrLoginScreen: () => null,
}));

function fakeSession(): LoginResponse {
  return { user_id: "@me:localhost", device_id: "DEVICE1" };
}

function fillRegistrationForm() {
  const registrationTab = screen.getByRole("tab", { name: "Create account" });
  registrationTab.focus();
  fireEvent.click(registrationTab);
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "alice" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse" } });
}

async function discoverLoginChoices() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("LoginScreen SSO callback handling", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    getCurrentUrls = null;
    openUrlCallback = undefined;
    getCurrent.mockClear();
    onOpenUrl.mockClear();
    openUrl.mockClear().mockResolvedValue(undefined);
    login.mockClear();
    register.mockClear();
    beginRegistration.mockReset();
    requestRegistrationEmail.mockReset();
    continueRegistration.mockReset();
    cancelRegistration.mockReset().mockResolvedValue(undefined);
    getLoginFlows.mockReset().mockResolvedValue({
      password: true,
      token: false,
      sso: true,
      identity_providers: [],
    });
    loginWithToken.mockReset();
    featureFlags.registrationEnabled = false;
    featureFlags.initialized = true;
    startSsoLogin.mockClear().mockResolvedValue("https://homeserver.example/sso");
    completeSsoLogin.mockClear();
    cancelSsoLogin.mockClear().mockResolvedValue(undefined);
  });

  it("completes sign-in when a legitimate charm://sso-callback deep link arrives after SSO was started", async () => {
    completeSsoLogin.mockResolvedValue(fakeSession());
    const onSignedIn = vi.fn();
    render(<LoginScreen onSignedIn={onSignedIn} />);

    await act(async () => {
      screen.getByRole("button", { name: "Continue with SSO" }).click();
    });
    expect(openUrl).toHaveBeenCalledWith("https://homeserver.example/sso");

    await act(async () => {
      openUrlCallback?.(["charm://sso-callback?loginToken=abc&state=xyz"]);
    });

    expect(completeSsoLogin).toHaveBeenCalledWith("charm://sso-callback?loginToken=abc&state=xyz");
    expect(onSignedIn).toHaveBeenCalledWith(fakeSession());
  });

  it("does not register Tauri deep-link handlers in web builds", () => {
    vi.stubEnv("VITE_CHARM_BUILD_TARGET", "web");

    render(<LoginScreen onSignedIn={vi.fn()} />);

    expect(getCurrent).not.toHaveBeenCalled();
    expect(onOpenUrl).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Continue with SSO" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in with QR code" })).not.toBeInTheDocument();
  });

  it("ignores a spoofed deep link whose scheme merely starts with the callback prefix", async () => {
    // Regression guard for the anchored SSO_CALLBACK_URL_PATTERN: neither of
    // these should be mistaken for a real charm://sso-callback.
    const onSignedIn = vi.fn();
    render(<LoginScreen onSignedIn={onSignedIn} />);

    await act(async () => {
      screen.getByRole("button", { name: "Continue with SSO" }).click();
    });

    await act(async () => {
      openUrlCallback?.([
        "charm://sso-callback-evil?loginToken=abc",
        "charm://sso-callback.evil.com?loginToken=abc",
      ]);
    });

    expect(completeSsoLogin).not.toHaveBeenCalled();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("does not act on a callback for an SSO attempt that was never started (or already finished)", async () => {
    // ssoInProgressRef is only set once handleSsoLogin actually runs — a
    // callback arriving without that (e.g. delivered twice, or delivered
    // after the user already cancelled) must be ignored by the onOpenUrl
    // listener, unlike the cold-launch path which has no such guard.
    const onSignedIn = vi.fn();
    render(<LoginScreen onSignedIn={onSignedIn} />);

    await act(async () => {
      openUrlCallback?.(["charm://sso-callback?loginToken=abc"]);
    });

    expect(completeSsoLogin).not.toHaveBeenCalled();
  });

  it("completes sign-in from a cold-launch callback URL with no prior in-process SSO attempt", async () => {
    getCurrentUrls = ["charm://sso-callback?loginToken=cold&state=xyz"];
    completeSsoLogin.mockResolvedValue(fakeSession());
    const onSignedIn = vi.fn();

    await act(async () => {
      render(<LoginScreen onSignedIn={onSignedIn} />);
    });

    expect(completeSsoLogin).toHaveBeenCalledWith("charm://sso-callback?loginToken=cold&state=xyz");
    expect(onSignedIn).toHaveBeenCalledWith(fakeSession());
  });

  it("cancelling SSO stops a later callback from completing it", async () => {
    const onSignedIn = vi.fn();
    render(<LoginScreen onSignedIn={onSignedIn} />);

    await act(async () => {
      screen.getByRole("button", { name: "Continue with SSO" }).click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "Cancel" }).click();
    });
    expect(cancelSsoLogin).toHaveBeenCalled();

    await act(async () => {
      openUrlCallback?.(["charm://sso-callback?loginToken=late"]);
    });

    expect(completeSsoLogin).not.toHaveBeenCalled();
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});

describe("LoginScreen default homeserver URL", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    getCurrentUrls = null;
    openUrlCallback = undefined;
    getCurrent.mockClear();
    onOpenUrl.mockClear();
    openUrl.mockClear().mockResolvedValue(undefined);
    login.mockClear();
    register.mockClear();
    beginRegistration.mockReset();
    requestRegistrationEmail.mockReset();
    continueRegistration.mockReset();
    cancelRegistration.mockReset().mockResolvedValue(undefined);
    getLoginFlows.mockReset().mockResolvedValue({
      password: true,
      token: false,
      sso: true,
      identity_providers: [],
    });
    loginWithToken.mockReset();
    featureFlags.registrationEnabled = false;
    startSsoLogin.mockClear().mockResolvedValue("https://homeserver.example/sso");
    completeSsoLogin.mockClear();
    cancelSsoLogin.mockClear().mockResolvedValue(undefined);
  });

  it("prefills the homeserver field from VITE_CHARM_DEFAULT_HOMESERVER_URL when set", () => {
    vi.stubEnv("VITE_CHARM_DEFAULT_HOMESERVER_URL", "https://matrix.example.org");

    render(<LoginScreen onSignedIn={vi.fn()} />);

    expect(screen.getByLabelText("Homeserver")).toHaveValue("https://matrix.example.org");
  });

  it("falls back to the cloudhub.social default when the env var is unset", () => {
    render(<LoginScreen onSignedIn={vi.fn()} />);

    expect(screen.getByLabelText("Homeserver")).toHaveValue("https://cloudhub.social");
  });

  it("falls back to the cloudhub.social default when the env var is an empty string", () => {
    vi.stubEnv("VITE_CHARM_DEFAULT_HOMESERVER_URL", "");

    render(<LoginScreen onSignedIn={vi.fn()} />);

    expect(screen.getByLabelText("Homeserver")).toHaveValue("https://cloudhub.social");
  });
});

describe("LoginScreen registration UIA", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    getCurrentUrls = null;
    openUrlCallback = undefined;
    getCurrent.mockClear();
    onOpenUrl.mockClear();
    openUrl.mockReset().mockResolvedValue(undefined);
    login.mockReset();
    register.mockReset();
    beginRegistration.mockReset();
    continueRegistration.mockReset();
    cancelRegistration.mockReset().mockResolvedValue(undefined);
    getLoginFlows.mockReset().mockResolvedValue({
      password: true,
      token: false,
      sso: true,
      identity_providers: [],
    });
    loginWithToken.mockReset();
    startSsoLogin.mockReset().mockResolvedValue("https://homeserver.example/sso");
    completeSsoLogin.mockReset();
    cancelSsoLogin.mockReset().mockResolvedValue(undefined);
    featureFlags.registrationEnabled = true;
  });

  it("continues a terms challenge and signs in after registration completes", async () => {
    beginRegistration.mockResolvedValue({
      state: "challenge",
      attempt_id: "attempt-1",
      completed: [],
      flows: [{ stages: ["m.login.terms", "m.login.dummy"] }],
      next_stage: "m.login.terms",
      fallback_url: "https://matrix.example/_matrix/client/v3/auth/m.login.terms/fallback/web",
      policies: [
        {
          id: "privacy",
          version: "1",
          language: "en",
          name: "Privacy policy",
          url: "https://matrix.example/privacy",
        },
      ],
    });
    continueRegistration
      .mockResolvedValueOnce({
        state: "challenge",
        attempt_id: "attempt-1",
        completed: ["m.login.terms"],
        flows: [{ stages: ["m.login.terms", "m.login.dummy"] }],
        next_stage: "m.login.dummy",
        fallback_url: "https://matrix.example/_matrix/client/v3/auth/m.login.dummy/fallback/web",
        policies: [],
      })
      .mockResolvedValueOnce({ state: "complete", session: fakeSession() });
    const onSignedIn = vi.fn();
    render(<LoginScreen onSignedIn={onSignedIn} />);
    fillRegistrationForm();

    await act(async () => {
      screen.getByRole("button", { name: "Create account" }).click();
    });

    expect(beginRegistration).toHaveBeenCalledWith({
      homeserver_url: "https://cloudhub.social",
      username: "alice",
      password: "correct horse",
    });
    expect(
      screen.getByText("Review and accept the homeserver policies to continue."),
    ).toBeVisible();

    await act(async () => {
      screen.getByRole("button", { name: "Read Privacy policy" }).click();
    });
    expect(openUrl).toHaveBeenCalledWith("https://matrix.example/privacy");

    await act(async () => {
      screen.getByRole("button", { name: "Accept and continue" }).click();
    });
    expect(continueRegistration).toHaveBeenCalledWith("attempt-1", { kind: "accept_terms" });
    expect(continueRegistration).toHaveBeenCalledWith("attempt-1", { kind: "complete_dummy" });
    expect(onSignedIn).toHaveBeenCalledWith(fakeSession());
  });

  it("opens the homeserver fallback and cancels an unfinished challenge", async () => {
    beginRegistration.mockResolvedValue({
      state: "challenge",
      attempt_id: "attempt-2",
      completed: [],
      flows: [{ stages: ["m.login.recaptcha"] }],
      next_stage: "m.login.recaptcha",
      fallback_url:
        "https://matrix.example/_matrix/client/v3/auth/m.login.recaptcha/fallback/web?session=opaque",
      policies: [],
    });
    render(<LoginScreen onSignedIn={vi.fn()} />);
    fillRegistrationForm();

    await act(async () => {
      screen.getByRole("button", { name: "Create account" }).click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "Open verification" }).click();
    });
    expect(openUrl).toHaveBeenCalledWith(
      "https://matrix.example/_matrix/client/v3/auth/m.login.recaptcha/fallback/web?session=opaque",
    );

    await act(async () => {
      screen.getByRole("button", { name: "Cancel account creation" }).click();
    });
    expect(cancelRegistration).toHaveBeenCalledWith("attempt-2");
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("keeps registration email credentials behind the attempt boundary", async () => {
    beginRegistration.mockResolvedValue({
      state: "challenge",
      attempt_id: "attempt-email",
      completed: [],
      flows: [{ stages: ["m.login.email.identity"] }],
      next_stage: "m.login.email.identity",
      fallback_url:
        "https://matrix.example/_matrix/client/v3/auth/m.login.email.identity/fallback/web",
      policies: [],
    });
    requestRegistrationEmail.mockResolvedValue({ requires_token: true });
    continueRegistration.mockResolvedValue({ state: "complete", session: fakeSession() });
    const onSignedIn = vi.fn();
    render(<LoginScreen onSignedIn={onSignedIn} />);
    fillRegistrationForm();

    await act(async () => {
      screen.getByRole("button", { name: "Create account" }).click();
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "alice@example.org" },
    });
    await act(async () => {
      screen.getByRole("button", { name: "Send verification email" }).click();
    });

    expect(requestRegistrationEmail).toHaveBeenCalledWith("attempt-email", "alice@example.org");
    fireEvent.change(screen.getByLabelText("Email token"), {
      target: { value: "123456" },
    });
    await act(async () => {
      screen.getByRole("button", { name: "Resend verification email" }).click();
    });
    expect(screen.getByLabelText("Email token")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Email token"), {
      target: { value: "654321" },
    });
    await act(async () => {
      screen.getByRole("button", { name: "Complete email verification" }).click();
    });

    expect(continueRegistration).toHaveBeenCalledWith("attempt-email", {
      kind: "complete_email",
      token: "654321",
    });
    expect(onSignedIn).toHaveBeenCalledWith(fakeSession());
  });

  it("ignores a registration email response after account creation is cancelled", async () => {
    beginRegistration.mockResolvedValue({
      state: "challenge",
      attempt_id: "attempt-email",
      completed: [],
      flows: [{ stages: ["m.login.email.identity"] }],
      next_stage: "m.login.email.identity",
      fallback_url: "",
      policies: [],
    });
    let resolveEmail: ((challenge: { requires_token: boolean }) => void) | undefined;
    requestRegistrationEmail.mockReturnValue(
      new Promise((resolve) => {
        resolveEmail = resolve;
      }),
    );
    render(<LoginScreen onSignedIn={vi.fn()} />);
    fillRegistrationForm();
    await act(async () => {
      screen.getByRole("button", { name: "Create account" }).click();
    });
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "alice@example.org" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send verification email" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel account creation" }));

    await act(async () => {
      resolveEmail?.({ requires_token: true });
      await Promise.resolve();
    });

    expect(screen.queryByLabelText("Email token")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create account" })).toBeVisible();
  });

  it("clears an expired registration challenge instead of leaving stale controls", async () => {
    beginRegistration.mockResolvedValue({
      state: "challenge",
      attempt_id: "attempt-expired",
      completed: [],
      flows: [{ stages: ["m.login.terms"] }],
      next_stage: "m.login.terms",
      fallback_url: "",
      policies: [],
    });
    continueRegistration.mockRejectedValue(new Error("registration attempt is no longer current"));
    render(<LoginScreen onSignedIn={vi.fn()} />);
    fillRegistrationForm();

    await act(async () => {
      screen.getByRole("button", { name: "Create account" }).click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "Accept and continue" }).click();
    });

    expect(screen.queryByRole("button", { name: "Accept and continue" })).not.toBeInTheDocument();
    expect(screen.getByText(/registration attempt is no longer current/i)).toBeVisible();
  });
});

describe("LoginScreen login choices", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.unstubAllEnvs();
    getCurrentUrls = null;
    openUrlCallback = undefined;
    getCurrent.mockClear();
    onOpenUrl.mockClear();
    openUrl.mockReset().mockResolvedValue(undefined);
    login.mockReset();
    loginWithToken.mockReset().mockResolvedValue(fakeSession());
    register.mockReset();
    beginRegistration.mockReset();
    requestRegistrationEmail.mockReset();
    continueRegistration.mockReset();
    cancelRegistration.mockReset().mockResolvedValue(undefined);
    discoverHomeserver.mockReset().mockResolvedValue({
      homeserver_url: "https://matrix.example/",
    });
    getLoginFlows.mockReset().mockResolvedValue({
      password: true,
      token: true,
      sso: true,
      identity_providers: [{ id: "company", name: "Company SSO", brand: null }],
    });
    startSsoLogin.mockReset().mockResolvedValue("https://homeserver.example/sso/company");
    completeSsoLogin.mockReset();
    cancelSsoLogin.mockReset().mockResolvedValue(undefined);
    featureFlags.registrationEnabled = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts SSO with a homeserver-advertised identity provider", async () => {
    render(<LoginScreen onSignedIn={vi.fn()} />);
    await discoverLoginChoices();

    expect(screen.queryByRole("button", { name: "Continue with SSO" })).not.toBeInTheDocument();
    await act(async () => {
      screen.getByRole("button", { name: "Continue with Company SSO" }).click();
    });

    expect(startSsoLogin).toHaveBeenCalledWith("https://cloudhub.social", "company");
    expect(openUrl).toHaveBeenCalledWith("https://homeserver.example/sso/company");
  });

  it("uses an advertised standalone login token without persisting it in the form", async () => {
    const onSignedIn = vi.fn();
    render(<LoginScreen onSignedIn={onSignedIn} />);
    await discoverLoginChoices();

    fireEvent.click(screen.getByRole("button", { name: "Use a login token" }));
    fireEvent.change(screen.getByLabelText("Login token"), {
      target: { value: "one-time-secret" },
    });
    await act(async () => {
      screen.getByRole("button", { name: "Use login token" }).click();
    });

    expect(loginWithToken).toHaveBeenCalledWith("https://matrix.example/", "one-time-secret");
    expect(onSignedIn).toHaveBeenCalledWith(fakeSession());
  });

  it("falls back to generic SSO when login-flow discovery fails", async () => {
    getLoginFlows.mockRejectedValue(new Error("unavailable"));

    render(<LoginScreen onSignedIn={vi.fn()} />);
    await discoverLoginChoices();

    expect(screen.getByRole("button", { name: "Continue with SSO" })).toBeVisible();
  });

  it("keeps generic SSO available when homeserver resolution fails", async () => {
    discoverHomeserver.mockRejectedValue(new Error("offline"));

    render(<LoginScreen onSignedIn={vi.fn()} />);
    await discoverLoginChoices();

    expect(screen.getByRole("button", { name: "Continue with SSO" })).toBeVisible();
  });

  it("hides password submission when the homeserver does not advertise it", async () => {
    getLoginFlows.mockResolvedValue({
      password: false,
      token: false,
      sso: true,
      identity_providers: [{ id: "company", name: "Company SSO", brand: null }],
    });

    render(<LoginScreen onSignedIn={vi.fn()} />);
    await discoverLoginChoices();

    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue with Company SSO" })).toBeVisible();
  });

  it("clears a homeserver-scoped token while login flows reload", async () => {
    render(<LoginScreen onSignedIn={vi.fn()} />);
    await discoverLoginChoices();

    fireEvent.click(screen.getByRole("button", { name: "Use a login token" }));
    fireEvent.change(screen.getByLabelText("Login token"), {
      target: { value: "one-time-secret" },
    });
    fireEvent.change(screen.getByLabelText("Homeserver"), {
      target: { value: "https://other.example" },
    });

    expect(screen.queryByLabelText("Login token")).not.toBeInTheDocument();
  });
});

describe("LoginScreen password recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.unstubAllEnvs();
    getCurrentUrls = null;
    openUrlCallback = undefined;
    openUrl.mockReset().mockResolvedValue(undefined);
    login.mockReset();
    loginWithToken.mockReset();
    requestPasswordReset.mockReset();
    confirmPasswordReset.mockReset();
    cancelPasswordReset.mockReset().mockResolvedValue(undefined);
    discoverHomeserver.mockReset().mockResolvedValue({
      homeserver_url: "https://matrix.example/",
    });
    getLoginFlows.mockReset().mockResolvedValue({
      password: true,
      token: false,
      sso: true,
      identity_providers: [],
    });
    featureFlags.registrationEnabled = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests email recovery and confirms a homeserver-submitted reset", async () => {
    requestPasswordReset.mockResolvedValue({
      attempt_id: "reset-attempt",
      requires_token: false,
    });
    confirmPasswordReset.mockResolvedValue(undefined);
    render(<LoginScreen onSignedIn={vi.fn()} />);
    await discoverLoginChoices();

    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "old password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(screen.queryByDisplayValue("old password")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "alice@example.org" },
    });
    await act(async () => {
      screen.getByRole("button", { name: "Send recovery email" }).click();
    });

    expect(requestPasswordReset).toHaveBeenCalledWith(
      "https://cloudhub.social",
      "alice@example.org",
    );
    expect(
      screen.getByText(
        "Follow the instructions in your email. If it includes a token, enter it below.",
      ),
    ).toBeVisible();
    expect(screen.getByLabelText("Email token (if provided)")).toBeVisible();

    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new correct horse" },
    });
    await act(async () => {
      screen.getByRole("button", { name: "Reset password" }).click();
    });

    expect(confirmPasswordReset).toHaveBeenCalledWith(
      "reset-attempt",
      undefined,
      "new correct horse",
    );
    expect(screen.getByText("Password updated")).toBeVisible();
  });

  it("shows the same pre-verification state for an opaque rejected recovery request", async () => {
    requestPasswordReset.mockResolvedValue({
      attempt_id: "opaque-rejected-attempt",
      requires_token: false,
    });
    render(<LoginScreen onSignedIn={vi.fn()} />);
    await discoverLoginChoices();

    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "missing@example.org" },
    });
    await act(async () => {
      screen.getByRole("button", { name: "Send recovery email" }).click();
    });

    expect(screen.getByText(/Follow the instructions in your email/i)).toBeVisible();
    expect(screen.getByLabelText("Email token (if provided)")).toBeVisible();
  });

  it("can close recovery while its request is still pending", async () => {
    let resolveRequest: ((challenge: PasswordResetChallenge) => void) | undefined;
    requestPasswordReset.mockReturnValue(
      new Promise<PasswordResetChallenge>((resolve) => {
        resolveRequest = resolve;
      }),
    );
    render(<LoginScreen onSignedIn={vi.fn()} />);
    await discoverLoginChoices();

    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "alice@example.org" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send recovery email" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Forgot password?" })).toBeVisible();
    expect(cancelPasswordReset).toHaveBeenCalledWith(undefined);

    await act(async () => {
      resolveRequest?.({ attempt_id: "late-attempt", requires_token: false });
      await Promise.resolve();
    });
    expect(cancelPasswordReset).toHaveBeenCalledWith("late-attempt");
  });

  it("cancels a direct-token recovery attempt without exposing its backend session", async () => {
    requestPasswordReset.mockResolvedValue({
      attempt_id: "token-attempt",
      requires_token: true,
    });
    render(<LoginScreen onSignedIn={vi.fn()} />);
    await discoverLoginChoices();

    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "alice@example.org" },
    });
    await act(async () => {
      screen.getByRole("button", { name: "Send recovery email" }).click();
    });
    expect(screen.getByLabelText("Email token (if provided)")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(cancelPasswordReset).toHaveBeenCalledWith("token-attempt");
    expect(screen.getByRole("button", { name: "Forgot password?" })).toBeVisible();
  });

  it("returns to the request step after a password-reset attempt expires", async () => {
    requestPasswordReset.mockResolvedValue({
      attempt_id: "expired-attempt",
      requires_token: false,
    });
    confirmPasswordReset.mockRejectedValue(
      new Error("password reset attempt expired or was cancelled"),
    );
    render(<LoginScreen onSignedIn={vi.fn()} />);
    await discoverLoginChoices();

    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "alice@example.org" },
    });
    await act(async () => {
      screen.getByRole("button", { name: "Send recovery email" }).click();
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "new correct horse" },
    });
    await act(async () => {
      screen.getByRole("button", { name: "Reset password" }).click();
    });

    expect(screen.getByRole("button", { name: "Send recovery email" })).toBeVisible();
    expect(screen.getByText("Password reset expired. Request a new recovery email.")).toBeVisible();
  });

  it("does not offer legacy recovery when the homeserver has no password flow", async () => {
    getLoginFlows.mockResolvedValue({
      password: false,
      token: false,
      sso: true,
      identity_providers: [{ id: "mas", name: "Account provider" }],
    });
    render(<LoginScreen onSignedIn={vi.fn()} />);

    await discoverLoginChoices();

    expect(screen.queryByRole("button", { name: "Forgot password?" })).not.toBeInTheDocument();
  });
});
