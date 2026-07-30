import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

const USER_ID = "@e2e-registration:localhost";

test("registration completes a homeserver terms and dummy UIA flow", async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_REGISTRATION",
    room: { room_id: "!registration:localhost", name: "Registration", unread_count: 0 },
    hasRooms: false,
    restoreSession: false,
    registrationUia: true,
  });
  await page.goto("/");

  await page.getByRole("tab", { name: "Create account" }).click();
  await page.getByLabel("Homeserver").fill("https://matrix.example");
  await page.getByLabel("Username").fill("e2e-registration");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(
    page.getByText("Review and accept the homeserver policies to continue."),
  ).toBeVisible();
  await captureSnapshot(page, "registration-terms-challenge");
  await page.getByRole("button", { name: "Accept and continue" }).click();

  await expect(page.getByRole("heading", { name: "Welcome to Charm" })).toBeVisible();
});

test("login choices expose a homeserver provider and standalone token login", async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_LOGIN_CHOICES",
    room: { room_id: "!login-choices:localhost", name: "Login choices", unread_count: 0 },
    hasRooms: false,
    restoreSession: false,
    loginChoices: true,
  });
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Continue with Company SSO" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with SSO" })).not.toBeVisible();
  await page.getByRole("button", { name: "Continue with Company SSO" }).click();
  await expect(page.getByText("Waiting for you to finish in the browser…")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Use a login token" }).click();
  await page.getByLabel("Login token").fill("one-time-token");
  await page.getByRole("button", { name: "Use login token" }).click();

  await expect(page.getByRole("heading", { name: "Welcome to Charm" })).toBeVisible();
});

test("password recovery requests email validation and sets a new password", async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_PASSWORD_RECOVERY",
    room: { room_id: "!password-recovery:localhost", name: "Recovery", unread_count: 0 },
    hasRooms: false,
    restoreSession: false,
    passwordRecovery: true,
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Forgot password?" }).click();
  await page.getByLabel("Email").fill("alice@example.org");
  await page.getByRole("button", { name: "Send recovery email" }).click();
  await expect(page.getByText("Open the link in your email, then return here.")).toBeVisible();
  await page.getByLabel("New password").fill("new correct horse battery staple");
  await page.getByRole("button", { name: "Reset password" }).click();

  await expect(page.getByText("Password updated")).toBeVisible();
  await captureSnapshot(page, "password-recovery-complete");
  await page.getByRole("button", { name: "Return to sign in" }).click();
  await expect(page.getByRole("button", { name: "Forgot password?" })).toBeVisible();
});
