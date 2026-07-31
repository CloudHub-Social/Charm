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
