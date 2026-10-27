import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

const ROOM = { room_id: "!action-viewport:localhost", name: "Action viewport", unread_count: 0 };
const USER_ID = "@viewport:localhost";
const longBody = Array.from({ length: 100 }, (_, index) => "Scrollable message line " + index).join(
  "\n",
);

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

for (const input of ["pointer", "touch"] as const) {
  test.describe(input, () => {
    test.use({ hasTouch: input === "touch" });

    for (const layout of ["bubble", "discord", "irc"] as const) {
      for (const position of ["top", "tall"] as const) {
        test(layout + " keeps " + position + "-edge actions visible", async ({ page }) => {
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
          await row.evaluate(
            (element, offset) => {
              const viewport = element.closest("[data-virtuoso-scroller]")!;
              const rowTop = element.getBoundingClientRect().top;
              const viewportTop = viewport.getBoundingClientRect().top;
              viewport.scrollTop += rowTop - viewportTop + offset;
            },
            position === "tall" ? 200 : 0,
          );
          await expect
            .poll(() =>
              row.evaluate((element, tall) => {
                const viewport = element.closest("[data-virtuoso-scroller]")!;
                const delta =
                  element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
                // Scroll range and fractional pixels differ by layout. Require the
                // actual collision, not one specific scroll offset or signed zero.
                return tall ? delta < -40 : Math.abs(delta) <= 1;
              }, position === "tall"),
            )
            .toBe(true);

          const point = await row.evaluate((element) => {
            const viewport = element.closest("[data-virtuoso-scroller]")!.getBoundingClientRect();
            const content = element.querySelector(".rich-message")!.getBoundingClientRect();
            return {
              x: content.left + Math.min(30, content.width / 2),
              y:
                (Math.max(viewport.top, content.top) + Math.min(viewport.bottom, content.bottom)) /
                2,
            };
          });
          await expect
            .poll(() =>
              row.evaluate(
                (element, p) => element.contains(document.elementFromPoint(p.x, p.y)),
                point,
              ),
            )
            .toBe(true);
          const more = row.getByRole("button", { name: "More actions" });
          if (input === "touch") {
            await page.touchscreen.tap(point.x, point.y);
            await expect(more).toBeFocused();
          } else {
            await page.mouse.move(point.x, point.y);
          }
          await expect(row.locator("[data-message-actions]")).toHaveCSS("opacity", "1");
          await expect
            .poll(() =>
              more.evaluate((button) => {
                const viewport = button
                  .closest("[data-virtuoso-scroller]")!
                  .getBoundingClientRect();
                const bounds = button.getBoundingClientRect();
                const hit = document.elementFromPoint(
                  (bounds.left + bounds.right) / 2,
                  (bounds.top + bounds.bottom) / 2,
                );
                return (
                  bounds.top >= viewport.top &&
                  bounds.bottom <= viewport.bottom &&
                  bounds.left >= viewport.left &&
                  bounds.right <= viewport.right &&
                  button.contains(hit)
                );
              }),
            )
            .toBe(true);
          await more.click();
          await expect(page.getByRole("menuitem", { name: "Reply", exact: true })).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(more).toBeFocused();
          await captureSnapshot(
            page,
            "message-action-viewport-" + input + "-" + layout + "-" + position,
          );
        });
      }
    }
  });
}
