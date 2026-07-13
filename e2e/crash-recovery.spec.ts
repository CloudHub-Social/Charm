import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

/**
 * End-to-end coverage of `main.tsx`'s crash-recovery nudge: when
 * `had_unclean_previous_session` reports the previous run didn't exit
 * cleanly (see `src-tauri/src/lib.rs`'s marker-file logic) and Sentry consent
 * is currently off (always true in this harness — there's no real Tauri
 * store backing `readObservabilitySettings`), `CrashRecoveryPrompt` should
 * appear once at boot, and either action (dismiss, or "review settings")
 * should close it without re-appearing.
 */

const ROOM = { room_id: "!e2e:localhost", name: "E2E Room", unread_count: 0 };
const USER_ID = "@e2e:localhost";

test("crash recovery: prompt does not appear after a clean previous session", async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
    previousSessionCrashed: false,
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: ROOM.name })).toBeVisible();

  await expect(
    page.getByRole("heading", { name: "Charm didn't close cleanly last time" }),
  ).toHaveCount(0);
});

test("crash recovery: dismissing the prompt closes it for the rest of the session", async ({
  page,
}) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
    previousSessionCrashed: true,
  });
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Charm didn't close cleanly last time" }),
  ).toBeVisible();
  await captureSnapshot(page, "crash-recovery-prompt");

  await page.getByRole("button", { name: "Not now" }).click();

  await expect(
    page.getByRole("heading", { name: "Charm didn't close cleanly last time" }),
  ).toHaveCount(0);
});

test("crash recovery: reviewing settings opens Observability and closes the prompt", async ({
  page,
}) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
    previousSessionCrashed: true,
  });
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Charm didn't close cleanly last time" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Review crash reporting settings" }).click();

  await expect(
    page.getByRole("heading", { name: "Charm didn't close cleanly last time" }),
  ).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Observability" })).toBeVisible();
});
