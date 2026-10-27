import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

test.use({ hasTouch: true });

const ROOM = { room_id: "!action-viewport:localhost", name: "Action viewport", unread_count: 0 };
const USER_ID = "@viewport:localhost";
const longBody = Array.from({ length: 100 }, (_, index) => "Scrollable message line " + index).join("\n");

function message(eventId: string, body: string) {
  return {
    event_id: eventId,
    sender: USER_ID,
    sender_display_name: "Viewport tester",
    sender_avatar_url: null,
    sender_avatar_path: null,
    body,
    formatted_body: null,
    timestamp_ms: 1788724800000,
    edited: false,
    redacted: false,
    reactions: [],
    in_reply_to: null,
    transaction_id: null,
    send_state: { state: "sent" },
    media: null,
    poll: null,
    is_undecrypted: false,
    text_editable: true,
  };
}

for (const layout of ["bubble", "discord", "irc"] as const) {
  for (const position of ["top", "tall"] as const) {
    test(layout + " keeps " + position + "-edge actions inside the visible timeline", async ({ page }) => {
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
        deviceId: "ACTION_VIEWPORT",
        room: ROOM,
        initialMessages:
          position === "top"
            ? [message("$target", "Top-edge message"), message("$filler", longBody)]
            : [message("$target", longBody)],
      });
      await page.goto("/");
      await page.getByRole("button", { name: ROOM.name }).click();
      const scroller = page.locator("[data-virtuoso-scroller]");
      await scroller.evaluate((element) => {
        element.scrollTop = 0;
      });
      const row = page.locator('[id="message-$target"]');
      await expect(row).toBeVisible();
      await row.evaluate((element, offset) => {
        const viewport = element.closest("[data-virtuoso-scroller]")!;
        viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + offset;
      }, position === "tall" ? 200 : 0);
      await expect
        .poll(() => row.evaluate((element) => {
          const viewport = element.closest("[data-virtuoso-scroller]")!;
          return Math.round(element.getBoundingClientRect().top - viewport.getBoundingClientRect().top);
        }))
        .toBe(position === "tall" ? -200 : 0);

      const point = await row.evaluate((element) => {
        const viewport = element.closest("[data-virtuoso-scroller]")!.getBoundingClientRect();
        const content = element.querySelector(".rich-message")!.getBoundingClientRect();
        return {
          x: content.left + Math.min(30, content.width / 2),
          y: (Math.max(viewport.top, content.top) + Math.min(viewport.bottom, content.bottom)) / 2,
        };
      });
      await page.mouse.move(point.x, point.y);
      const toolbar = row.locator("[data-message-actions]");
      await expect(toolbar).toHaveCSS("opacity", "1");
      const more = row.getByRole("button", { name: "More actions" });
      await expect
        .poll(() => more.evaluate((button) => {
          const viewport = button.closest("[data-virtuoso-scroller]")!.getBoundingClientRect();
          const bounds = button.getBoundingClientRect();
          return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom &&
            bounds.left >= viewport.left && bounds.right <= viewport.right &&
            button.contains(document.elementFromPoint((bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2));
        }))
        .toBe(true);
      await more.click();
      await expect(page.getByRole("menuitem", { name: "Reply", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");

      // A short touch on visible prose must reveal a reachable trigger without scrolling away.
      await page.getByPlaceholder("Message " + ROOM.name).focus();
      await page.mouse.move(4, 4);
      await page.touchscreen.tap(point.x, point.y);
      await expect(more).toBeFocused();
      await more.press("Enter");
      await expect(page.getByRole("menuitem", { name: "Reply", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await captureSnapshot(page, "message-action-viewport-" + layout + "-" + position);
    });
  }
}
