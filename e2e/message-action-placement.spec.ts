import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

const ROOM = { room_id: "!action-placement:localhost", name: "Action placement", unread_count: 0 };
const USER_ID = "@placement:localhost";

for (const layout of ["bubble", "discord", "irc"] as const) {
  test(`${layout} keeps focused actions above the message and within the timeline`, async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2026-09-07T12:00:00Z"));
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.addInitScript((messageLayout) => {
      localStorage.setItem(
        "charm:featureFlags",
        JSON.stringify({
          state: { overrides: { message_action_parity: true } },
          updatedAt: Date.now(),
        }),
      );
      localStorage.setItem(
        "charm:appearance",
        JSON.stringify({ state: { messageLayout }, updatedAt: Date.now() }),
      );
    }, layout);
    await page.addInitScript(installMockTauri, {
      userId: USER_ID,
      deviceId: "ACTION_PLACEMENT",
      room: ROOM,
    });
    await page.goto("/");
    await page.getByRole("button", { name: ROOM.name }).click();
    const composer = page.getByPlaceholder(`Message ${ROOM.name}`);
    await composer.fill("Keep this message readable");
    await composer.press("Enter");
    const body = page.getByText("Keep this message readable", { exact: true });
    await expect(body).toBeVisible();
    await expect(page.getByText(/sending…/)).toHaveCount(0);
    const row = body.locator("xpath=ancestor::*[contains(@class, 'group')][1]");
    const more = row.getByRole("button", { name: "More actions" });
    await more.focus();
    const actions = row.locator("[data-message-actions]");
    await expect(actions).toHaveCSS("opacity", "1");
    await expect
      .poll(() =>
        row.evaluate((element) => {
          const toolbar = element.querySelector("[data-message-actions]");
          const content = element.querySelector(".rich-message");
          const scroller = element.closest("[data-virtuoso-scroller]");
          if (!toolbar || !content || !scroller) return null;
          const actionBox = toolbar.getBoundingClientRect();
          const contentBox = content.getBoundingClientRect();
          const viewport = scroller.getBoundingClientRect();
          return {
            coversMessage: actionBox.bottom > contentBox.top,
            clippedTop: actionBox.top < viewport.top,
            clippedLeft: actionBox.left < viewport.left,
            clippedRight: actionBox.right > viewport.right,
          };
        }),
      )
      .toEqual({
        coversMessage: false,
        clippedTop: false,
        clippedLeft: false,
        clippedRight: false,
      });
    await more.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Reply", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(more).toBeFocused();
    await captureSnapshot(page, `message-action-placement-${layout}`);
  });
}
