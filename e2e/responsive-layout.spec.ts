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

test("keeps the mobile shell, navigation, composer, and header controls in the viewport", async ({
  page,
}) => {
  const composer = page.getByPlaceholder(`Message ${LONG_ROOM_NAME}`);
  const navigation = page.getByRole("navigation", { name: "Primary" });
  const infoButton = page.getByRole("button", { name: "Show members" });
  const settingsButton = page.getByRole("button", { name: "Room settings" });

  await expect(composer).toBeVisible();
  await expect(navigation).toBeVisible();
  await expect(infoButton).toBeVisible();
  await expect(settingsButton).toBeVisible();

  const [composerBox, navigationBox, viewport] = await Promise.all([
    composer.boundingBox(),
    navigation.boundingBox(),
    page.evaluate(() => ({
      height: window.visualViewport?.height ?? window.innerHeight,
      width: window.visualViewport?.width ?? window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    })),
  ]);

  expect(composerBox).not.toBeNull();
  expect(navigationBox).not.toBeNull();
  expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(viewport.height);
  expect(navigationBox!.y + navigationBox!.height).toBeLessThanOrEqual(viewport.height);
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width);
  await captureSnapshot(page, "responsive-mobile-shell");
});
