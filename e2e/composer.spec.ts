import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

/**
 * End-to-end coverage of Spec 04's acceptance flow — formatted text,
 * `:emoji:` resolution, `/me`, and an `@mention` — against the real app UI
 * with Tauri IPC faked in-browser (see `support/mockTauri.ts`).
 */

const ROOM = { room_id: "!e2e-composer:localhost", name: "Composer E2E Room", unread_count: 0 };
const USER_ID = "@e2e:localhost";
const OTHER_USER = { user_id: "@alice:localhost", display_name: "Alice" };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({
        state: { overrides: { rich_message_rendering: true } },
        updatedAt: Date.now(),
      }),
    );
  });
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
    members: [OTHER_USER],
  });
  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();
  await expect(page.getByText("No messages yet")).toBeVisible();
});

test("sends bolded text as formatted_body rendered with <strong>", async ({ page }) => {
  const composer = page.getByPlaceholder(`Message ${ROOM.name}`);
  await composer.fill("bold text");
  await composer.selectText();
  await page.getByRole("button", { name: /Bold/ }).click();
  await composer.press("Enter");

  const bubble = page.locator("strong", { hasText: "bold text" });
  await expect(bubble).toBeVisible();
  await captureSnapshot(page, "composer-bold-text");
});

test("resolves a :shortcode: to its emoji glyph on send", async ({ page }) => {
  const composer = page.getByPlaceholder(`Message ${ROOM.name}`);
  await composer.fill("hi :smile:");
  await composer.press("Enter");

  await expect(page.getByText("hi 😄", { exact: true })).toBeVisible();
  await captureSnapshot(page, "composer-emoji-shortcode");
});

test("runs /me without sending it as literal text", async ({ page }) => {
  const composer = page.getByPlaceholder(`Message ${ROOM.name}`);
  await composer.fill("/me waves");
  await composer.press("Enter");

  // run_command's mock resolves success — no error banner, and the literal
  // "/me waves" text never lands as a plain message bubble.
  await expect(page.getByText("/me waves", { exact: true })).toHaveCount(0);
  await captureSnapshot(page, "composer-slash-me");
});

test("inserts an @ mention pill from the autocomplete menu", async ({ page }) => {
  const composer = page.getByPlaceholder(`Message ${ROOM.name}`);
  await composer.pressSequentially("hey @ali");

  const option = page.getByRole("option", { name: "Alice" });
  await expect(option).toBeVisible();
  await option.click();
  await composer.press("Enter");

  const sentPill = page.getByRole("button", { name: "@Alice" });
  await expect(sentPill).toBeVisible();
  await expect(page.locator("p", { has: sentPill })).toContainText("hey");
  await captureSnapshot(page, "composer-mention-pill");
});
