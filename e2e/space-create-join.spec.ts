import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

/**
 * Spec 19 Phase 4 coverage: the space rail's "+" entry point opens the
 * create/join dialog, and both the create-a-new-space and join-by-address
 * flows land the user in the new/joined space via the real IPC round trip
 * (against the fake backend's `create_space`/`join_room` handlers — see
 * `mockTauri.ts`).
 */

const USER_ID = "@e2e:localhost";
const HOME_ROOM_ID = "!space-create-join-home:e2e";

test("creates a new space and switches into it", async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: { room_id: HOME_ROOM_ID, name: "Home base", unread_count: 0 },
  });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await page.getByRole("button", { name: "Create or join space" }).click();

  await expect(page.getByRole("heading", { name: "Create or join a space" })).toBeVisible();
  await page.getByLabel("Name").fill("Engineering");
  await page.getByRole("button", { name: "Create space" }).click();

  await expect(page.getByRole("heading", { name: "Engineering" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create or join a space" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Engineering", exact: true })).toBeVisible();
  await captureSnapshot(page, "space-create-join-created");
});

test("joins a space by address and switches into it", async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: { room_id: HOME_ROOM_ID, name: "Home base", unread_count: 0 },
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Create or join space" }).click();
  await expect(page.getByRole("heading", { name: "Create or join a space" })).toBeVisible();

  const joinTab = page.getByRole("tab", { name: "Join by address" });
  await joinTab.click();
  await page.getByLabel("Space address").fill("#design-team:e2e");
  await page.getByRole("button", { name: "Join space" }).click();

  await expect(page.getByRole("heading", { name: "#design-team:e2e" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create or join a space" })).toHaveCount(0);
});

test("shows an inline error and stays open when creation fails", async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: { room_id: HOME_ROOM_ID, name: "Home base", unread_count: 0 },
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Create or join space" }).click();
  await page.getByRole("button", { name: "Create space" }).click();

  await expect(page.getByText("Name is required.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create or join a space" })).toBeVisible();
});
