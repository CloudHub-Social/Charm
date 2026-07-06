import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";

/**
 * End-to-end coverage of Spec 01's acceptance criteria: the room list and an
 * open room show resolved names, and no raw `@user:server` MXID leaks into
 * the sender label when a display name has resolved — against the real app
 * UI with Tauri IPC faked in-browser (see `support/mockTauri.ts`).
 */

const ROOM = { room_id: "!e2e-identity:localhost", name: "Identity E2E Room", unread_count: 0 };
const USER_ID = "@e2e:localhost";
const ALICE = "@alice:localhost";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
    members: [{ user_id: ALICE, display_name: "Alice Anderson" }],
  });
  await page.goto("/");
});

test("shows the room's human name, not its room id, in the room list", async ({ page }) => {
  await expect(page.getByRole("button", { name: ROOM.name })).toBeVisible();
  await expect(page.getByText(ROOM.room_id)).toHaveCount(0);
});

test("renders a message sender's resolved display name, not the raw MXID", async ({ page }) => {
  await page.getByRole("button", { name: ROOM.name }).click();
  await expect(page.getByText("No messages yet")).toBeVisible();

  await page.evaluate(
    ({ roomId, sender }) => {
      // Simulates a `timeline:update` push the way a real room's live
      // Timeline would deliver it once matrix-sdk-ui resolves the sender's
      // profile — see `timeline.rs`'s `sender_profile_fields`.
      // oxlint-disable-next-line no-underscore-dangle
      (window as unknown as { __e2eEmit: (event: string, payload: unknown) => void }).__e2eEmit(
        "timeline:update",
        {
          room_id: roomId,
          messages: [
            {
              event_id: "$from-alice",
              sender,
              sender_display_name: "Alice Anderson",
              sender_avatar_url: null,
              sender_avatar_path: null,
              body: "hello from alice",
              formatted_body: null,
              timestamp_ms: Date.now(),
              edited: false,
              redacted: false,
              reactions: [],
              in_reply_to: null,
              transaction_id: null,
              send_state: { state: "sent" },
              media: null,
            },
          ],
        },
      );
    },
    { roomId: ROOM.room_id, sender: ALICE },
  );

  await expect(page.getByText("Alice Anderson")).toBeVisible();
  await expect(page.getByText(ALICE)).toHaveCount(0);
});
