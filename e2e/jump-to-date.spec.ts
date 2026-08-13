import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

test("jumps from the room calendar to the first message on a date", async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: "@e2e:localhost",
    deviceId: "E2E_DEVICE",
    room: { room_id: "!history:e2e", name: "Project History", unread_count: 0 },
    jumpToDate: true,
    initialMessages: [
      {
        event_id: "$january",
        sender: "@alice:localhost",
        body: "January planning notes",
        timestamp_ms: new Date("2025-01-15T10:00:00").getTime(),
        reactions: [],
        in_reply_to: null,
        transaction_id: null,
        send_state: { state: "sent" },
      },
      {
        event_id: "$february",
        sender: "@bob:localhost",
        body: "February project checkpoint",
        timestamp_ms: new Date("2025-02-03T09:30:00").getTime(),
        reactions: [],
        in_reply_to: null,
        transaction_id: null,
        send_state: { state: "sent" },
      },
    ],
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Project History" }).click();
  await page.getByRole("button", { name: "Jump to date" }).click();
  const dateInput = page.getByRole("textbox", { name: "Date", exact: true });
  await dateInput.fill("2025-02-03");
  await dateInput.blur();
  await captureSnapshot(page, "jump-to-date-picker");
  await page.getByRole("button", { name: "Jump", exact: true }).click();

  await expect(page.locator('[data-message-event-id="$february"]')).toHaveAttribute(
    "data-jump-highlighted",
    "true",
  );
  await expect(page.getByRole("button", { name: "Jump to present" })).toBeVisible();
});
