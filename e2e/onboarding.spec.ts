import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

/**
 * End-to-end coverage of Spec 12's two headline scenarios: a brand-new
 * account (zero joined rooms, no onboarding flags) sees `OnboardingScreen`
 * and can skip straight to the room list, while a returning account (at
 * least one joined room) never sees it at all. See `support/mockTauri.ts`
 * for exactly what's faked.
 */

const ROOM = { room_id: "!e2e-onboarding:localhost", name: "E2E Room", unread_count: 0 };
const USER_ID = "@e2e-onboarding:localhost";

test("register a fresh account: onboarding appears, and skipping lands on the room list", async ({
  page,
}) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
    hasRooms: false,
  });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Welcome to Charm" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  await captureSnapshot(page, "onboarding-welcome-screen");

  await page.getByRole("button", { name: "Skip" }).click();

  // This account has zero rooms (`hasRooms: false`), so `RoomsScreen`
  // renders its empty room list rather than the seeded room button — the
  // "Open settings" chrome (always present once `RoomsScreen` mounts) is
  // what actually distinguishes "onboarding is done" here.
  await expect(page.getByRole("button", { name: "Open settings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Welcome to Charm" })).not.toBeVisible();
  await captureSnapshot(page, "onboarding-skipped-to-room-list");
});

test("an account with an existing room never sees onboarding", async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
    hasRooms: true,
  });
  await page.goto("/");

  await expect(page.getByRole("button", { name: ROOM.name })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Welcome to Charm" })).not.toBeVisible();
  await captureSnapshot(page, "onboarding-returning-account-room-list");
});
