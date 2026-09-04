import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

const ROOM = { room_id: "!composer:localhost", name: "Composer Room", unread_count: 0 };

for (const enabled of [false, true]) {
  test.describe(`composer parity flag ${enabled ? "on" : "off"}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((flag) => {
        localStorage.setItem(
          "charm:featureFlags",
          JSON.stringify({
            // Narrow-width cases exercise the mobile shell's formatting toggle;
            // composer parity still varies independently in both states.
            state: { overrides: { composer_parity: flag, mobile_chat_redesign: true } },
            updatedAt: Date.now(),
          }),
        );
      }, enabled);
      await page.addInitScript(installMockTauri, {
        userId: "@composer:localhost",
        deviceId: "COMPOSER_DEVICE",
        room: ROOM,
      });
      await page.goto("/");
      await page.getByRole("button", { name: ROOM.name }).click();
      await expect(page.getByText("No messages yet")).toBeVisible();
    });

    test("gates new controls and empty-composer editing without changing drafts", async ({
      page,
    }) => {
      const composer = page.getByPlaceholder(`Message ${ROOM.name}`);
      for (const name of ["Spoiler", "Strikethrough", "Code block"]) {
        await expect(page.getByRole("button", { name, exact: true })).toHaveCount(enabled ? 1 : 0);
      }
      await expect(composer).toHaveAttribute("spellcheck", String(enabled));
      await captureSnapshot(page, `composer-parity-controls-${enabled ? "on" : "off"}`);
      await composer.fill("original composer message");
      await composer.press("Enter");
      await expect(page.getByText("original composer message", { exact: true })).toBeVisible();
      await expect(page.getByText(/sending…/)).toHaveCount(0);

      await composer.fill("keep this draft");
      await composer.press("ArrowUp");
      await expect(composer).toHaveText("keep this draft");
      await expect(page.getByText("Editing message", { exact: true })).toHaveCount(0);

      await composer.fill("");
      await composer.press("ArrowUp");
      if (enabled) {
        await expect(page.getByText("Editing message", { exact: true })).toBeVisible();
        await expect(composer).toHaveText("original composer message");
        await captureSnapshot(page, "composer-parity-keyboard-edit");
        await composer.fill("updated via keyboard");
        await composer.press("Enter");
        await expect(page.getByText("updated via keyboard", { exact: true })).toBeVisible();
        // Bubble layout shares the edited suffix with its timestamp; it is
        // not a standalone text node (see BubbleMessageRow).
        await expect(page.getByText(/\(edited\)$/)).toBeVisible();
        await expect(page.getByText("original composer message", { exact: true })).toHaveCount(0);
        await expect(page.getByText("Editing message", { exact: true })).toHaveCount(0);
      } else {
        await expect(page.getByText("Editing message", { exact: true })).toHaveCount(0);
        await expect(composer).toHaveText("");
      }
    });

    test("gates the plain-message slash command", async ({ page }) => {
      const composer = page.getByPlaceholder(`Message ${ROOM.name}`);
      await composer.fill("/plain <b>literal markup</b>");
      await composer.press("Enter");
      await expect(
        page.getByText(enabled ? "<b>literal markup</b>" : "/plain <b>literal markup</b>", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByText(/sending…/)).toHaveCount(0);
    });

    for (const width of [320, 375]) {
      test(`keeps formatting controls inside the composer at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 740 });
        await page.getByRole("button", { name: "Show formatting", exact: true }).click();
        const toolbar = page.getByRole("toolbar", { name: "Formatting" });
        await expect(toolbar).toBeVisible();
        await expect
          .poll(async () =>
            toolbar.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              return (
                bounds.left >= 0 &&
                bounds.right <= window.innerWidth &&
                [...element.querySelectorAll("button")].every((button) => {
                  const rect = button.getBoundingClientRect();
                  return (
                    rect.left >= bounds.left &&
                    rect.right <= bounds.right + 1 &&
                    rect.top >= bounds.top &&
                    rect.bottom <= bounds.bottom + 1
                  );
                })
              );
            }),
          )
          .toBe(true);
      });
    }
  });
}
