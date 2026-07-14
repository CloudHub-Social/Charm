import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

const JOINED_ROOM = { room_id: "!joined:e2e", name: "General", unread_count: 0 };
const INVITED_ROOM = {
  room_id: "!invited:e2e",
  name: "Project room",
  membership: "invite",
  inviter_user_id: "@alice:e2e",
  inviter_display_name: "Alice",
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({ state: { overrides: { room_invites: true } }, updatedAt: Date.now() }),
    );
  });
  await page.addInitScript(installMockTauri, {
    userId: "@invitee:e2e",
    deviceId: "INVITE_E2E",
    room: JOINED_ROOM,
    extraRooms: [INVITED_ROOM],
  });
  await page.goto("/");
});

test("accepts a pending room invite and opens the joined room", async ({ page }) => {
  await expect(page.getByText("Alice invited you")).toBeVisible();
  await page.getByRole("button", { name: "Accept" }).click();

  await expect(page.getByPlaceholder(`Message ${INVITED_ROOM.name}`)).toBeVisible();
  await expect(page.getByText("Alice invited you")).toHaveCount(0);
  await captureSnapshot(page, "room-invite-accepted");
});

test("declines a pending room invite", async ({ page }) => {
  await expect(page.getByText("Alice invited you")).toBeVisible();
  await page.getByRole("button", { name: "Decline" }).click();

  await expect(page.getByText("Alice invited you")).toHaveCount(0);
  await expect(page.getByRole("button", { name: INVITED_ROOM.name })).toHaveCount(0);
  await captureSnapshot(page, "room-invite-declined");
});
