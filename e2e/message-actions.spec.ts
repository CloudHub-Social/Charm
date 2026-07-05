import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";

/**
 * End-to-end coverage of Spec 03's acceptance flow (send -> react -> edit ->
 * reply -> delete) against the real app UI running on the Vite dev server,
 * with the Tauri IPC layer faked in-browser — see `support/mockTauri.ts` for
 * exactly what's faked and why there's no real Tauri host or homeserver
 * involved.
 */

const ROOM = { room_id: "!e2e:localhost", name: "E2E Room", unread_count: 0 };
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

test("send, react, edit, reply, and delete a message", async ({ page }) => {
  const composer = page.getByPlaceholder(`Message ${ROOM.name}`);

  // --- send ---
  await composer.fill("hello there");
  await composer.press("Enter");
  const originalBubble = page.getByText("hello there", { exact: true });
  await expect(originalBubble).toBeVisible();

  const originalRow = originalBubble.locator("xpath=ancestor::*[contains(@class, 'group')][1]");

  // --- react ---
  await originalRow.getByRole("button", { name: "React", exact: true }).click();
  await page.getByRole("button", { name: "React with 👍" }).click();
  await expect(originalRow.getByText("👍", { exact: true })).toBeVisible();
  await expect(originalRow.getByText("1", { exact: true })).toBeVisible();

  // --- edit ---
  await originalRow.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(page.getByText("Editing message")).toBeVisible();
  await composer.fill("hello there, edited");
  await composer.press("Enter");
  await expect(page.getByText("hello there, edited", { exact: true })).toBeVisible();
  await expect(page.getByText("(edited)")).toBeVisible();

  const editedRow = page
    .getByText("hello there, edited", { exact: true })
    .locator("xpath=ancestor::*[contains(@class, 'group')][1]");

  // --- reply ---
  await editedRow.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Reply" }).click();
  await expect(page.getByText(`Replying to ${USER_ID}`)).toBeVisible();
  await composer.fill("replying now");
  await composer.press("Enter");
  const replyBubble = page.getByText("replying now", { exact: true });
  await expect(replyBubble).toBeVisible();
  const replyRow = replyBubble.locator("xpath=ancestor::*[contains(@class, 'group')][1]");
  // The reply's quoted preview renders the replied-to sender's id.
  await expect(replyRow.getByText(USER_ID, { exact: true })).toBeVisible();

  // --- delete ---
  await replyRow.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByText("Message deleted")).toBeVisible();
  await expect(page.getByText("replying now")).toHaveCount(0);
});
