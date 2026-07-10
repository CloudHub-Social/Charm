import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke as transportInvoke } from "./matrixTransport";
import {
  bootstrapCrossSigning,
  changePassword,
  completeSsoLogin,
  deactivateAccount,
  deleteDevice,
  discoverHomeserver,
  login,
  register,
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
    ["discover_homeserver", () => discoverHomeserver("example.org")],
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
