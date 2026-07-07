import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

/**
 * End-to-end coverage of Spec 17's golden path: open the room settings modal
 * from the chat header, rename a room, and invite a member — against the
 * real app UI with Tauri IPC faked in-browser (see `support/mockTauri.ts`).
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

test("opens the room settings modal from the chat header", async ({ page }) => {
  await page.getByRole("button", { name: "Room settings" }).click();

  await expect(page.getByRole("tab", { name: "General", selected: true })).toBeVisible();
  await expect(page.getByLabel("Room name")).toHaveValue(ROOM.name);
  await captureSnapshot(page, "room-settings-modal-open");
});

test("renames a room end-to-end and reflects it in the header and room list", async ({ page }) => {
  await page.getByRole("button", { name: "Room settings" }).click();

  const nameField = page.getByLabel("Room name");
  await nameField.fill("Renamed via E2E");
  await page.getByRole("button", { name: "Save" }).first().click();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Renamed via E2E" })).toBeVisible();
  await expect(page.getByText("Renamed via E2E", { exact: true }).first()).toBeVisible();
  await captureSnapshot(page, "room-info-renamed");
});

test("invites a member and it appears in the Invited filter", async ({ page }) => {
  await page.getByRole("button", { name: "Room settings" }).click();
  await page.getByRole("tab", { name: "Members" }).click();

  await page.getByRole("button", { name: "Invite" }).click();
  await page.getByLabel("Matrix ID").fill("@bob:example.org");
  await page.getByRole("button", { name: "Send invite" }).click();

  await page.getByRole("button", { name: "Joined" }).click();
  await page.getByRole("menuitemradio", { name: "Invited" }).click();

  await expect(page.getByText("@bob:example.org").first()).toBeVisible();
  await captureSnapshot(page, "room-info-member-invited");
});

test("browses members from the lightweight members drawer", async ({ page }) => {
  await page.getByRole("button", { name: "Show members" }).click();

  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  await captureSnapshot(page, "members-drawer-open");
});
