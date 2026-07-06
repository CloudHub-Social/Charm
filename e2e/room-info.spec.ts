import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";

/**
 * End-to-end coverage of Spec 07's golden path: open the right panel from
 * the chat header, rename a room, and invite a member — against the real
 * app UI with Tauri IPC faked in-browser (see `support/mockTauri.ts`).
 */

const ROOM = { room_id: "!e2e-room-info:localhost", name: "Room Info E2E Room", unread_count: 0 };
const USER_ID = "@e2e:localhost";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
  });
  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();
  await expect(page.getByText("No messages yet")).toBeVisible();
});

test("opens the room info panel from the chat header", async ({ page }) => {
  await page.getByRole("button", { name: "Show room info" }).click();

  await expect(page.getByRole("heading", { name: "Room info" })).toBeVisible();
  await expect(page.getByLabel("Room name")).toHaveValue(ROOM.name);
});

test("renames a room end-to-end and reflects it in the header and room list", async ({ page }) => {
  await page.getByRole("button", { name: "Show room info" }).click();

  const nameField = page.getByLabel("Room name");
  await nameField.fill("Renamed via E2E");
  await page.getByRole("button", { name: "Save" }).first().click();

  await expect(page.getByRole("button", { name: "Renamed via E2E" })).toBeVisible();
  await expect(page.getByText("Renamed via E2E", { exact: true }).first()).toBeVisible();
});

test("invites a member and it appears in the member list", async ({ page }) => {
  await page.getByRole("button", { name: "Show room info" }).click();
  await page.getByRole("tab", { name: "Members" }).click();

  await page.getByRole("button", { name: "Invite" }).click();
  await page.getByLabel("Matrix ID").fill("@bob:example.org");
  await page.getByRole("button", { name: "Send invite" }).click();

  await expect(page.getByText("@bob:example.org").first()).toBeVisible();
});
