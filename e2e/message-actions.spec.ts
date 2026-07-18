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
/** Only the "forward" test needs a second joined room to pick as a target. */
const OTHER_ROOM_NAME = "Other Room";

test.beforeEach(async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({
        state: { overrides: { message_action_parity: true } },
        updatedAt: Date.now(),
      }),
    );
  });
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
    extraRooms: testInfo.title.includes("forwards a message")
      ? [{ room_id: "!other:localhost", name: OTHER_ROOM_NAME }]
      : undefined,
  });
  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();
  await expect(page.getByText("No messages yet")).toBeVisible();
});

test("copies the canonical permalink for a sent message", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const composer = page.getByPlaceholder(`Message ${ROOM.name}`);
  await composer.fill("copy my link");
  await composer.press("Enter");

  const row = page
    .getByText("copy my link", { exact: true })
    .locator("xpath=ancestor::*[contains(@class, 'group')][1]");
  await row.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Copy link" }).click();

  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("https://matrix.to/#/%21e2e%3Alocalhost/%241?via=localhost");
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

  // Regression coverage for issue #162: an unreacted message renders no
  // reaction-bar row at all (no persistent "+" chip wasting space) — only
  // the hover-revealed "React" button below is present.
  await expect(originalRow.getByRole("button", { name: "Add reaction" })).toHaveCount(0);

  // --- react ---
  await originalRow.getByRole("button", { name: "React", exact: true }).click();
  // Scoped to the popover content: with `message_action_parity` on, the
  // quick-react row (Spec 37) also renders a same-labelled "React with 👍"
  // button directly in the row (👍 is in the default recent-emoji set), so
  // an unscoped query here would match both and violate strict mode.
  await page
    .locator('[data-slot="popover-content"]')
    .getByRole("button", { name: "React with 👍" })
    .click();
  // Scoped to the pressed reaction chip: the quick-react row (Spec 37) also
  // renders a same-emoji "React with 👍" button in this row, so an unscoped
  // text query would match both it and the chip.
  const reactionChip = originalRow.getByRole("button", { name: /👍/, pressed: true });
  await expect(reactionChip).toBeVisible();
  await expect(reactionChip.getByText("1", { exact: true })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Delete message?" })).toBeVisible();
  await page.getByLabel("Reason (optional)").fill("duplicate reply");
  await page.getByRole("button", { name: "Delete message" }).click();
  await expect(page.getByText("Message deleted")).toBeVisible();
  await expect(page.getByText("replying now")).toHaveCount(0);
});

test("opening More-actions still closes another already-open Radix popover on the same row", async ({
  page,
}) => {
  // Regression coverage for issue #231's review feedback on the #226 fix: an
  // earlier version stopped the "More actions" trigger's pointerdown from
  // propagating to fix #226 (reopening the menu was a no-op), but that also
  // stopped the *same* event from reaching any other already-open Radix
  // layer's outside-pointerdown listener — e.g. this row's own EmojiPicker
  // popover, opened via "React", would no longer close when "More actions"
  // was clicked next. The fix (deferring the DropdownMenu's own open-state
  // update by a macrotask instead of stopping propagation) must both open
  // the menu (not self-dismiss, #226) AND still let the pointerdown bubble
  // far enough to dismiss the EmojiPicker popover (this issue).
  const composer = page.getByPlaceholder(`Message ${ROOM.name}`);
  await composer.fill("cross-popover test");
  await composer.press("Enter");
  const row = page
    .getByText("cross-popover test", { exact: true })
    .locator("xpath=ancestor::*[contains(@class, 'group')][1]");

  await row.getByRole("button", { name: "React", exact: true }).click();
  // Scoped to the popover content: with `message_action_parity` on, the
  // quick-react row (Spec 37) also renders a persistent same-labelled
  // "React with 👍" button directly in the row, so an unscoped query would
  // match it too and violate strict mode / never reach zero below.
  const popoverReactWithThumbsUp = page
    .locator('[data-slot="popover-content"]')
    .getByRole("button", { name: "React with 👍" });
  await expect(popoverReactWithThumbsUp).toBeVisible();

  await row.getByRole("button", { name: "More actions" }).click();

  // The click both opened the dropdown (not a #226 self-dismiss no-op)...
  await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
  // ...and closed the EmojiPicker popover it interrupted.
  await expect(popoverReactWithThumbsUp).toHaveCount(0);
});

test("views raw event source for a sent message", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const composer = page.getByPlaceholder(`Message ${ROOM.name}`);
  await composer.fill("show me the source");
  await composer.press("Enter");

  const row = page
    .getByText("show me the source", { exact: true })
    .locator("xpath=ancestor::*[contains(@class, 'group')][1]");
  await row.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "View source" }).click();

  await expect(page.getByRole("heading", { name: "View source" })).toBeVisible();
  await expect(page.getByText(/"show me the source"/)).toBeVisible();

  await page.getByRole("button", { name: "Copy" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("show me the source");
});

test("reports another user's message with a reason", async ({ page }) => {
  const OTHER_USER = "@other:localhost";
  // Seed a message from someone else, since own messages can't be reported.
  await page.evaluate((sender) => {
    // oxlint-disable-next-line no-underscore-dangle
    window.__e2eEmit("timeline:update", {
      room_id: "!e2e:localhost",
      messages: [
        {
          event_id: "$other-1",
          sender,
          sender_display_name: null,
          sender_avatar_url: null,
          sender_avatar_path: null,
          body: "reportable message",
          formatted_body: null,
          timestamp_ms: Date.now(),
          edited: false,
          redacted: false,
          reactions: [],
          in_reply_to: null,
          transaction_id: null,
          send_state: { state: "sent" },
        },
      ],
    });
  }, OTHER_USER);

  const row = page
    .getByText("reportable message", { exact: true })
    .locator("xpath=ancestor::*[contains(@class, 'group')][1]");
  await row.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Report" }).click();
  await expect(page.getByRole("heading", { name: "Report message?" })).toBeVisible();
  await page.getByLabel("Reason (optional)").fill("spam");
  // The dropdown's "Report" menuitem is already closed by this point, so the
  // confirm dialog's "Report" button is the only match.
  await page.getByRole("button", { name: "Report" }).click();
  await expect(page.getByRole("heading", { name: "Report message?" })).toHaveCount(0);
});

test("views edit history for an edited message", async ({ page }) => {
  const composer = page.getByPlaceholder(`Message ${ROOM.name}`);
  await composer.fill("original body");
  await composer.press("Enter");
  await expect(page.getByText("original body", { exact: true })).toBeVisible();

  const originalRow = page
    .getByText("original body", { exact: true })
    .locator("xpath=ancestor::*[contains(@class, 'group')][1]");
  await originalRow.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await composer.fill("edited body");
  await composer.press("Enter");
  await expect(page.getByText("edited body", { exact: true })).toBeVisible();

  const editedRow = page
    .getByText("edited body", { exact: true })
    .locator("xpath=ancestor::*[contains(@class, 'group')][1]");
  await editedRow.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit history" }).click();

  // Scoped to the dialog: "edited body" also still matches the live message
  // bubble behind the overlay, so an unscoped query would match both.
  const dialog = page.locator('[data-slot="dialog-content"]');
  await expect(dialog.getByRole("heading", { name: "Edit history" })).toBeVisible();
  await expect(dialog.getByText("Original", { exact: true })).toBeVisible();
  await expect(dialog.getByText("edited body", { exact: true })).toBeVisible();
});

test("shows who reacted in a hover tooltip", async ({ page }) => {
  const composer = page.getByPlaceholder(`Message ${ROOM.name}`);
  await composer.fill("react to me");
  await composer.press("Enter");
  const row = page
    .getByText("react to me", { exact: true })
    .locator("xpath=ancestor::*[contains(@class, 'group')][1]");

  await row.getByRole("button", { name: "React", exact: true }).click();
  await page
    .locator('[data-slot="popover-content"]')
    .getByRole("button", { name: "React with 🎉" })
    .click();

  const chip = row.getByRole("button", { name: /🎉/, pressed: true });
  await expect(chip).toBeVisible();
  await chip.hover();
  // Scoped to the tooltip content: the current user's id also appears
  // elsewhere on the page (sidebar profile), so an unscoped query matches
  // more than one element.
  // `.first()`: Radix Tooltip renders its content into two portal nodes
  // (one used for layout measurement), both matching this query.
  await expect(
    page.locator('[data-slot="tooltip-content"]').getByText(USER_ID, { exact: true }).first(),
  ).toBeVisible();
});

test("forwards a message to another joined room", async ({ page }) => {
  const composer = page.getByPlaceholder(`Message ${ROOM.name}`);
  await composer.fill("forward me");
  await composer.press("Enter");

  const row = page
    .getByText("forward me", { exact: true })
    .locator("xpath=ancestor::*[contains(@class, 'group')][1]");
  await row.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Forward" }).click();

  // Scoped to the dialog: the sidebar's own room-list row for the same
  // room name is also on the page (behind the overlay), so an unscoped
  // query would match both and violate strict mode.
  const dialog = page.locator('[data-slot="dialog-content"]');
  await expect(dialog.getByRole("heading", { name: "Forward message" })).toBeVisible();
  await dialog.getByRole("button", { name: OTHER_ROOM_NAME }).click();
  await expect(page.getByRole("heading", { name: "Forward message" })).toHaveCount(0);

  await page.getByRole("button", { name: OTHER_ROOM_NAME }).click();
  await expect(page.getByText("forward me", { exact: true })).toBeVisible();
});
