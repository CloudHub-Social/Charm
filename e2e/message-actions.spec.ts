import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

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

test("sending a message shows exactly one bubble that goes pending -> sent, never duplicated", async ({
  page,
}) => {
  // Spec 14 regression coverage: the pre-Spec-14 client-side optimistic echo
  // (keyed on a client-invented id) and the real synced event used to be two
  // separate items the frontend had to reconcile — see
  // `support/mockTauri.ts`'s `send_message` handler, which now models the
  // real `Timeline`'s two-phase local echo (`timeline:update` carrying
  // `send_state: "pending"` first, then a second `timeline:update` replacing
  // it in place with `send_state: "sent"`) instead of resolving straight to
  // "sent". ChatShell no longer creates its own echo at all — it just
  // renders whatever `timeline:update` sends, so this exercises exactly the
  // duplicate/stuck-pending bug this spec fixes.
  const composer = page.getByPlaceholder(`Message ${ROOM.name}`);

  await composer.fill("exactly one bubble please");
  await composer.press("Enter");

  const bubble = page.getByText("exactly one bubble please", { exact: true });
  await expect(bubble).toBeVisible();
  await expect(bubble).toHaveCount(1);
  await expect(page.getByText(/sending…/)).toBeVisible();

  // Once the mocked "remote echo" lands, the same single bubble reflects
  // sent, not stuck on "sending…" and not duplicated.
  await expect(page.getByText(/sending…/)).toHaveCount(0);
  await expect(bubble).toHaveCount(1);
  await captureSnapshot(page, "message-actions-single-sent-bubble");
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
  await captureSnapshot(page, "message-actions-reacted");

  // --- edit ---
  await originalRow.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(page.getByText("Editing message")).toBeVisible();
  await composer.fill("hello there, edited");
  await composer.press("Enter");
  await expect(page.getByText("hello there, edited", { exact: true })).toBeVisible();
  await expect(page.getByText("(edited)")).toBeVisible();
  await captureSnapshot(page, "message-actions-edited");

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
  await captureSnapshot(page, "message-actions-replied");

  // --- delete ---
  await replyRow.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByText("Message deleted")).toBeVisible();
  await expect(page.getByText("replying now")).toHaveCount(0);
});
