import { expect, test, type Page } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

test("fuzzy-switches with the keyboard and reopens with the room first", async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: "@e2e:localhost",
    deviceId: "E2E_DEVICE",
    room: { room_id: "!general:e2e", name: "General", unread_count: 0 },
    quickSwitcher: true,
    extraRooms: [
      { room_id: "!work:e2e", name: "Work", is_space: true },
      {
        room_id: "!design:e2e",
        name: "Design Studio",
        parent_space_ids: ["!work:e2e"],
      },
    ],
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open quick switcher" })).toBeVisible();

  // Chromium reserves Ctrl/Cmd-K for its omnibox before the page can observe
  // it, so dispatch the same window-level event that the desktop webview sends.
  await pressQuickSwitcherShortcut(page);
  const input = page.getByRole("combobox", {
    name: "Search rooms, direct messages, and spaces",
  });
  await expect(input).toBeFocused();
  await input.fill("dsgn stdio");
  await expect(page.getByRole("option", { name: /Design Studio/ })).toBeVisible();
  await captureSnapshot(page, "quick-switcher-results");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Message Design Studio" })).toBeVisible();

  await pressQuickSwitcherShortcut(page);
  const options = page.getByRole("option");
  await expect(options.first()).toContainText("Design Studio");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Quick switcher" })).toHaveCount(0);
});

async function pressQuickSwitcherShortcut(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: "k",
      }),
    );
  });
}
