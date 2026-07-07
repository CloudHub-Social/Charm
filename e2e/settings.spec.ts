import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

/**
 * End-to-end coverage of Spec 08's two highest-priority flows: logging out
 * (the load-bearing new capability — Charm 2.0 had no way out of a signed-in
 * session before this spec) and starting an outgoing verification of another
 * session from the Devices panel. See `support/mockTauri.ts` for exactly
 * what's faked — there's no real Tauri host or homeserver involved.
 */

const ROOM = { room_id: "!e2e:localhost", name: "E2E Room", unread_count: 0 };
const USER_ID = "@e2e:localhost";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
    otherDevices: [
      { device_id: "OTHER_DEVICE", display_name: "Other session", is_verified: false },
    ],
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: ROOM.name })).toBeVisible();
});

test("settings: logging out returns to the login screen", async ({ page }) => {
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();

  await page.getByRole("button", { name: "Log out" }).first().click();
  await expect(page.getByRole("heading", { name: "Log out?" })).toBeVisible();
  await captureSnapshot(page, "settings-logout-confirm");

  await page.getByRole("button", { name: "Log out" }).last().click();

  await expect(page.getByText("Sign in to your homeserver")).toBeVisible();
});

test("settings: verifying another session opens the verification overlay", async ({ page }) => {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("tab", { name: "Devices" }).click();

  await expect(page.getByText("Other session", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Actions for Other session" }).click();
  await page.getByRole("menuitem", { name: "Verify" }).click();

  await expect(page.getByText("Verify new sign-in")).toBeVisible();
  await captureSnapshot(page, "settings-verify-overlay");
});

test("settings: shows a centered dialog on desktop widths", async ({ page }) => {
  await page.getByRole("button", { name: "Open settings" }).click();

  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
});

test("settings: switches to a full page (no dialog) at mobile widths", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();

  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close settings" })).toBeVisible();
});

test("settings: deep-links to a specific section via the URL hash", async ({ page }) => {
  await page.evaluate(() => {
    window.location.hash = "#/settings/devices";
  });

  await expect(page.getByText("Other session", { exact: true })).toBeVisible();
});

test("settings: bulk-signs-out multiple selected devices", async ({ page }) => {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("tab", { name: "Devices" }).click();
  await expect(page.getByText("Other session", { exact: true })).toBeVisible();

  await page.getByRole("checkbox", { name: "Select Other session" }).check();
  await expect(page.getByText("1 device selected")).toBeVisible();

  await page.getByRole("button", { name: "Sign out selected" }).click();
  await page
    .getByRole("dialog", { name: "Sign out 1 devices?" })
    .getByRole("button", { name: "Sign out" })
    .click();

  await expect(page.getByText("Other session", { exact: true })).toHaveCount(0);
});
