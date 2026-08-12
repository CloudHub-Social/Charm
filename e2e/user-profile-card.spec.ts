import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

const ROOM = { room_id: "!profile:e2e", name: "Profile Room", unread_count: 0 };
const MUTUAL_ROOM = {
  room_id: "!mutual:e2e",
  name: "Mutual Room",
  unread_count: 0,
  is_direct: true,
};
const OWN_USER = "@me:e2e";
const OTHER_USER = "@alice:e2e";

test("opens a message sender profile and navigates through a mutual room", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({
        state: {
          overrides: { user_profile_cards: true, presence_privacy_controls: true },
        },
        updatedAt: Date.now(),
      }),
    );
  });
  await page.addInitScript(installMockTauri, {
    userId: OWN_USER,
    deviceId: "PROFILE_DEVICE",
    room: ROOM,
    extraRooms: [MUTUAL_ROOM],
    members: [{ user_id: OTHER_USER, display_name: "Alice" }],
    initialMessages: [
      {
        event_id: "$profile-message",
        sender: OTHER_USER,
        sender_display_name: "Alice",
        sender_avatar_url: null,
        sender_avatar_path: null,
        body: "Open my profile",
        formatted_body: null,
        timestamp_ms: Date.now(),
        edited: false,
        redacted: false,
        is_undecrypted: false,
        in_reply_to: null,
        reactions: [],
        media: null,
        send_state: { state: "sent" },
      },
    ],
  });

  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();
  await page.getByRole("button", { name: "Open profile for Alice" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Alice" })).toBeVisible();
  await expect(dialog.getByText("online · Available")).toBeVisible();
  await expect(dialog.getByRole("button", { name: MUTUAL_ROOM.name })).toBeVisible();
  await captureSnapshot(page, "user-profile-card-message-sender");

  await dialog.getByRole("button", { name: MUTUAL_ROOM.name }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByPlaceholder(`Message ${MUTUAL_ROOM.name}`)).toBeVisible();

  await page.getByRole("button", { name: "Show members" }).click();
  await page.getByRole("button", { name: "Open profile for Alice" }).click();
  await expect(dialog.getByRole("button", { name: "Message" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Message" }).click();
  await expect(dialog).toHaveCount(0);
});
