import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

const LONG_ROOM_NAME =
  "A deliberately very long room name that must not push the header controls off screen";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(installMockTauri, {
    userId: "@mobile:localhost",
    deviceId: "MOBILE_E2E",
    room: { room_id: "!mobile:localhost", name: LONG_ROOM_NAME, unread_count: 0 },
  });
  await page.goto("/");
});

test("renders a bottom-anchored mobile chat with compact room controls", async ({ page }) => {
  const composer = page.getByPlaceholder("Message");
  const composerShell = page.getByTestId("composer-shell");
  const navigation = page.getByRole("navigation", { name: "Primary" });
  const backButton = page.getByRole("button", { name: "Back to chats" });
  const actionsButton = page.getByRole("button", { name: "Room actions" });
  const formattingButton = page.getByRole("button", { name: "Show formatting" });

  await expect(composer).toBeVisible();
  await expect(navigation).toHaveCount(0);
  await expect(backButton).toBeVisible();
  await expect(actionsButton).toBeVisible();
  await expect(formattingButton).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "Formatting" })).toHaveCount(0);

  const [composerBox, composerShellBox, backBox, actionsBox, viewport] = await Promise.all([
    composer.boundingBox(),
    composerShell.boundingBox(),
    backButton.boundingBox(),
    actionsButton.boundingBox(),
    page.evaluate(() => ({
      height: window.visualViewport?.height ?? window.innerHeight,
      width: window.visualViewport?.width ?? window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    })),
  ]);

  expect(composerBox).not.toBeNull();
  expect(composerShellBox).not.toBeNull();
  expect(backBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(viewport.height);
  expect(composerShellBox!.y + composerShellBox!.height).toBeGreaterThanOrEqual(
    viewport.height - 1,
  );
  expect(backBox!.width).toBeGreaterThanOrEqual(44);
  expect(backBox!.height).toBeGreaterThanOrEqual(44);
  expect(actionsBox!.width).toBeGreaterThanOrEqual(44);
  expect(actionsBox!.height).toBeGreaterThanOrEqual(44);
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width);
  await captureSnapshot(page, "responsive-mobile-shell");

  await formattingButton.click();
  await expect(page.getByRole("toolbar", { name: "Formatting" })).toBeVisible();
  await page.getByRole("button", { name: "Hide formatting" }).click();

  await actionsButton.click();
  await expect(page.getByRole("menuitem", { name: "Show members" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Room settings" })).toBeVisible();
});
