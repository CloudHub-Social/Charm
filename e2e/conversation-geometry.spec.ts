import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";

const ROOM = { room_id: "!geometry:localhost", name: "Geometry room", unread_count: 0 };

for (const layout of ["bubble", "discord", "irc"] as const) {
  for (const width of [320, 375, 390, 430]) {
    test(`${layout} contains long conversation content at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((messageLayout) => {
        localStorage.setItem(
          "charm:featureFlags",
          JSON.stringify({
            state: { overrides: { ux_refresh_v1: true, message_action_parity: true } },
            updatedAt: Date.now(),
          }),
        );
        localStorage.setItem(
          "charm:appearance",
          JSON.stringify({ state: { messageLayout }, updatedAt: Date.now() }),
        );
      }, layout);
      await page.addInitScript(installMockTauri, {
        userId: "@geometry:localhost",
        deviceId: "GEOMETRY_TEST",
        room: ROOM,
        initialMessages: [
          {
            event_id: "$geometry",
            sender: "@other:localhost",
            sender_display_name: "A deliberately long bridged participant name (Discord)",
            sender_avatar_url: null,
            sender_avatar_path: null,
            body: `A message with a long identifier: ${"x".repeat(200)}`,
            formatted_body: null,
            timestamp_ms: 1788724800000,
            edited: false,
            redacted: false,
            reactions: ["💜", "👍", "🎉", "👀", "✨"].map((key) => ({
              key,
              count: 2,
              reacted_by_me: false,
            })),
            in_reply_to: null,
            transaction_id: null,
            send_state: { state: "sent" },
            media: null,
            poll: null,
            is_undecrypted: false,
            text_editable: true,
          },
        ],
      });
      await page.goto("/");
      const row = page.locator('[id="message-$geometry"]');
      await expect(row).toBeVisible();

      // Row dimensions catch clipping that could fool a document-only check.
      await expect
        .poll(async () => {
          return row.evaluate((element) => {
            const viewportWidth = document.documentElement.clientWidth;
            const bounds = element.getBoundingClientRect();
            return {
              rowOverflow: Math.max(0, element.scrollWidth - element.clientWidth),
              rightOverflow: Math.max(0, bounds.right - viewportWidth),
              leftOverflow: Math.max(0, -bounds.left),
              documentOverflow: Math.max(
                0,
                document.documentElement.scrollWidth - viewportWidth,
              ),
            };
          });
        })
        .toEqual({ rowOverflow: 0, rightOverflow: 0, leftOverflow: 0, documentOverflow: 0 });

      const more = row.getByRole("button", { name: "More actions" });
      await more.click();
      await expect(page.getByRole("menuitem", { name: "Reply", exact: true })).toBeVisible();
    });
  }
}
