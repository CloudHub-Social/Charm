import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke as transportInvoke } from "./matrixTransport";
import {
  beginRegistration,
  bootstrapCrossSigning,
  cancelRegistration,
  cancelPasswordReset,
  changePassword,
  completeSsoLogin,
  confirmPasswordReset,
  deactivateAccount,
  deleteDevice,
  discoverHomeserver,
  getLoginFlows,
  login,
  loginWithToken,
  register,
  requestPasswordReset,
  continueRegistration,
  startQrLogin,
  startSsoLogin,
  submitQrCheckCode,
} from "./matrix";

vi.mock("./matrixTransport", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(transportInvoke).mockClear();
});

describe("expected-failure IPC calls opt out of Sentry capture", () => {
  it.each([
    ["login", () => login({ homeserver_url: "https://example.org", username: "a", password: "b" })],
    [
      "register",
      () => register({ homeserver_url: "https://example.org", username: "a", password: "b" }),
    ],
    [
      "begin_registration",
      () =>
        beginRegistration({
          homeserver_url: "https://example.org",
          username: "a",
          password: "b",
        }),
    ],
    ["continue_registration", () => continueRegistration("attempt", { kind: "complete_dummy" })],
    ["cancel_registration", () => cancelRegistration("attempt")],
    ["request_password_reset", () => requestPasswordReset("https://example.org", "a@example.org")],
    ["confirm_password_reset", () => confirmPasswordReset("attempt", "token", "new-password")],
    ["cancel_password_reset", () => cancelPasswordReset("attempt")],
    ["discover_homeserver", () => discoverHomeserver("example.org")],
    ["get_login_flows", () => getLoginFlows("https://example.org")],
    ["login_with_token", () => loginWithToken("https://example.org", "secret-token")],
    ["start_sso_login", () => startSsoLogin("https://example.org")],
    ["complete_sso_login", () => completeSsoLogin("charm://sso-callback")],
    ["start_qr_login", () => startQrLogin("https://example.org")],
    ["submit_qr_check_code", () => submitQrCheckCode(12)],
    ["bootstrap_cross_signing", () => bootstrapCrossSigning("password")],
    ["change_password", () => changePassword("new-password", "old-password")],
    ["deactivate_account", () => deactivateAccount("password")],
    ["delete_device", () => deleteDevice("device-id", "password")],
  ])("passes captureOnError: false for %s", async (command, call) => {
    await call();

    expect(transportInvoke).toHaveBeenCalledWith(
      command,
      expect.anything(),
      expect.objectContaining({ captureOnError: false }),
    );
  });
});
