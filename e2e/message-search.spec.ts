import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

const ROOM = { room_id: "!search:e2e", name: "Search Room", unread_count: 0 };

test("searches the current room and navigates to the selected message", async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: "@e2e:localhost",
    deviceId: "E2E_DEVICE",
    room: ROOM,
    messageSearch: true,
    quickSwitcher: true,
    initialMessages: [
      {
        event_id: "$search-result",
        sender: "@alice:localhost",
        sender_display_name: "Alice",
        sender_avatar_url: null,
        sender_avatar_path: null,
        body: "The encrypted local index found this message",
        formatted_body: null,
        timestamp_ms: 1_700_000_000_000,
        edited: false,
        redacted: false,
        reactions: [],
        in_reply_to: null,
        transaction_id: null,
        send_state: { state: "sent" },
      },
    ],
  });
  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();

  await page.keyboard.press("Control+f");
  await expect(page.getByRole("heading", { name: "Search messages" })).toBeVisible();
  await page.getByLabel("Message search query").fill("local index");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("local index", { exact: true })).toBeVisible();
  await captureSnapshot(page, "message-search-results");
  await page.getByRole("button", { name: /Search Room/ }).click();
  await expect(page.getByText("Opening this result may contact your homeserver")).toBeVisible();
  await page.getByRole("button", { name: "Open message" }).click();

  await expect(page.getByRole("heading", { name: "Search messages" })).toHaveCount(0);
  await expect(page.getByText("The encrypted local index found this message")).toBeVisible();
});
