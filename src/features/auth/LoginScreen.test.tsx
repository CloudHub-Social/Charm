import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginScreen } from "./LoginScreen";
import type { LoginResponse } from "@/lib/matrix";

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
const startSsoLogin = vi.fn().mockResolvedValue("https://homeserver.example/sso");
const completeSsoLogin = vi.fn();
const cancelSsoLogin = vi.fn().mockResolvedValue(undefined);
const discoverHomeserver = vi.fn().mockReturnValue(new Promise(() => {}));

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
  startSsoLogin: (...args: unknown[]) => startSsoLogin(...args),
  completeSsoLogin: (...args: unknown[]) => completeSsoLogin(...args),
  cancelSsoLogin: (...args: unknown[]) => cancelSsoLogin(...args),
  discoverHomeserver: (...args: unknown[]) => discoverHomeserver(...args),
}));

vi.mock("./QrLoginScreen", () => ({
  QrLoginScreen: () => null,
}));

function fakeSession(): LoginResponse {
  return { user_id: "@me:localhost", device_id: "DEVICE1" };
}

describe("LoginScreen SSO callback handling", () => {
  beforeEach(() => {
    getCurrentUrls = null;
    openUrlCallback = undefined;
    getCurrent.mockClear();
    onOpenUrl.mockClear();
    openUrl.mockClear().mockResolvedValue(undefined);
    login.mockClear();
    register.mockClear();
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
