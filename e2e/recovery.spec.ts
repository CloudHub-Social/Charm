import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

/**
 * End-to-end coverage of recovery-key restore (Matrix key backup / 4S): a
 * session missing local secrets (`recoveryState: "incomplete"` — see
 * `support/mockTauri.ts`) sees the Devices panel's Recovery prompt, can
 * restore with the right key, and sees a clear error on a wrong one.
 * Own file rather than added to `settings.spec.ts`: that file's shared
 * `beforeEach` seeds `recoveryState` at its "enabled"/hidden default for
 * every other Devices-panel scenario, so this needs its own seed per test
 * instead, matching `onboarding.spec.ts`'s shape.
 */

const ROOM = { room_id: "!e2e-recovery:localhost", name: "E2E Room", unread_count: 0 };
const USER_ID = "@e2e-recovery:localhost";

test("devices: recovery-key prompt restores this session's secrets", async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
    recoveryState: "incomplete" as const,
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: ROOM.name })).toBeVisible();

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("tab", { name: "Devices" }).click();

  await expect(page.getByRole("heading", { name: "Recovery" })).toBeVisible();
  await captureSnapshot(page, "recovery-prompt-incomplete");

  await page.getByLabel("Recovery key").fill("correct-key");
  await page.getByRole("button", { name: "Restore" }).click();

  await expect(page.getByRole("heading", { name: "Recovery" })).not.toBeVisible();
});

test("devices: a wrong recovery key surfaces an error instead of failing silently", async ({
  page,
}) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
    recoveryState: "incomplete" as const,
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: ROOM.name })).toBeVisible();

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("tab", { name: "Devices" }).click();

  await page.getByLabel("Recovery key").fill("wrong-key");
  await page.getByRole("button", { name: "Restore" }).click();

  await expect(page.getByText("Error: invalid recovery key")).toBeVisible();
  await captureSnapshot(page, "recovery-prompt-wrong-key");
  // Must not have cleared/dismissed the card on failure.
  await expect(page.getByRole("heading", { name: "Recovery" })).toBeVisible();
});
