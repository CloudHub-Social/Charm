import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

for (const touch of [false, true]) {
  test.describe(touch ? "adaptive touch" : "adaptive pointer", () => {
    test.use({ hasTouch: touch });

    test("retains the conversation owner through resize, context and keyboard Back", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.addInitScript(() => {
        localStorage.setItem(
          "charm:featureFlags",
          JSON.stringify({
            state: { overrides: { ux_refresh_v1: true } },
            updatedAt: Date.now(),
          }),
        );
        localStorage.setItem(
          "charm:pane-preferences:v1",
          JSON.stringify({ version: 1, roomSidebarWidth: 300 }),
        );
      });
      await page.addInitScript(installMockTauri, {
        userId: "@adaptive:example.org",
        deviceId: "SYNTHETIC_ADAPTIVE",
        room: { room_id: "!adaptive:example.org", name: "Adaptive fixture", unread_count: 0 },
      });
      await page.goto("/");
      await page.getByRole("button", { name: /Adaptive fixture/i }).click();
      const editor = page.locator('[contenteditable="true"]').first();
      await editor.fill("Synthetic draft survives resize");
      await editor.evaluate((node) => {
        node.setAttribute("data-adaptive-owner", "retained");
      });
      for (const width of [1199, 1200, 768, 834, 1024, 767, 390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const shell = page.locator("[data-layout-width]");
        await expect(shell).toHaveAttribute(
          "data-layout-width",
          width < 768 ? "compact" : width < 1200 ? "medium" : "wide",
        );
        await expect(editor).toHaveAttribute("data-adaptive-owner", "retained");
        await expect(editor).toContainText("Synthetic draft survives resize");
        await expect(page.getByRole("navigation", { name: "Primary", exact: true })).toHaveCount(0);
        if (width >= 768) {
          await expect(
            page.getByRole("navigation", { name: "Primary navigation", exact: true }),
          ).toBeVisible();
        }
        if (width >= 768) {
          await page.getByRole("button", { name: "Show members" }).click();
          await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
          if (width < 1200) await expect(editor).toBeHidden();
          else await expect(editor).toBeVisible();
          await captureSnapshot(page, `adaptive-${touch ? "touch" : "pointer"}-${width}-context`);
          await page.getByRole("button", { name: "Close members" }).click();
          await expect(editor).toBeVisible();
        }
        await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "20px";
      });
      const back = page.getByRole("button", { name: "Back to chats" });
      await back.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("navigation", { name: "Primary", exact: true })).toBeVisible();
      await page.getByRole("button", { name: /Adaptive fixture/i }).click();
      await expect(editor).toContainText("Synthetic draft survives resize");
      await expect(editor).toHaveAttribute("data-adaptive-owner", "retained");
      await captureSnapshot(page, `adaptive-${touch ? "touch" : "pointer"}-390-enlarged`);
      expect(await page.evaluate(() => localStorage.getItem("charm:pane-preferences:v1"))).toBe(
        JSON.stringify({ version: 1, roomSidebarWidth: 300 }),
      );
    });
  });
}
