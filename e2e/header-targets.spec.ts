import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";

test.use({ hasTouch: true });

for (const refresh of [false, true]) {
  for (const optional of [false, true]) {
    test(`room header targets and controls at tablet width (refresh=${refresh}, optional=${optional})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.addInitScript(installMockTauri, {
        userId: "@header:example.org",
        deviceId: "HEADER_TARGETS",
        room: {
          room_id: "!header:example.org",
          name: "A deliberately long room name for responsive header geometry and truncation",
          unread_count: 0,
        },
      });
      await page.addInitScript(
        ({ refresh, optional }) => {
          localStorage.setItem(
            "charm:featureFlags",
            JSON.stringify({
              state: {
                overrides: {
                  ux_refresh_v1: refresh,
                  message_pinning: optional,
                  jump_to_date: optional,
                },
              },
              updatedAt: Date.now(),
            }),
          );
        },
        { refresh, optional },
      );
      await page.goto("/");
      await page.getByRole("button", { name: /A deliberately long room name/ }).click();

      const members = page.getByRole("button", { name: "Show members" });
      const settings = page.getByRole("button", { name: "Room settings" });
      const pins = page.getByRole("button", { name: "Show pinned messages" });
      const date = page.getByRole("button", { name: "Jump to date" });
      await expect(members).toBeVisible();
      await expect(settings).toBeVisible();
      await expect(pins).toHaveCount(optional ? 1 : 0);
      await expect(date).toHaveCount(optional ? 1 : 0);
      const controls = optional ? [members, pins, date, settings] : [members, settings];
      const boxes = [];
      for (const control of controls) {
        const box = await control.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
        boxes.push(box!);
      }
      for (let index = 1; index < boxes.length; index++) {
        expect(boxes[index].x).toBeGreaterThanOrEqual(boxes[index - 1].x + boxes[index - 1].width);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        768,
      );
      await members.focus();
      await expect(members).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
      await page.getByRole("button", { name: "Close members" }).click();
      if (optional) {
        await pins.click();
        await expect(page.getByRole("button", { name: "Hide pinned messages" })).toBeVisible();
        await page.getByRole("button", { name: "Hide pinned messages" }).click();
        await date.click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.keyboard.press("Escape");
      }
      await settings.click();
      await expect(page.getByRole("dialog")).toBeVisible();
    });
  }
}
