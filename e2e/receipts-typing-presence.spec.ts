import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";

/**
 * End-to-end coverage of Spec 05's acceptance flow: opening a room with
 * unread messages clears its badge (read receipts + fully-read marker),
 * another user's typing indicator appears and disappears, and a DM peer's
 * presence dot renders — against the real app UI with Tauri IPC faked
 * in-browser (see `support/mockTauri.ts`).
 *
 * There's no second real client in this fake, so "another user" actions
 * (typing, presence, incoming receipts) are simulated by calling the page's
 * `window.__e2eEmit` escape hatch directly — the same mechanism
 * `support/mockTauri.ts` documents for driving server-pushed events a
 * scenario needs that the fake command handlers don't already produce as a
 * side effect.
 */

const OTHER_USER = "@bob:localhost";
const USER_ID = "@e2e:localhost";

declare global {
  interface Window {
    __e2eEmit: (event: string, payload: unknown) => void;
  }
}

test("opening a room with unread messages clears the unread badge", async ({ page }) => {
  // Two rooms, not one: `RoomsScreen` auto-selects `rooms[0]` on load (see
  // its own doc comment), which would call `mark_room_read` on the unread
  // room immediately and clear the badge before this test ever gets to
  // observe it — a second room lets it auto-select *that* one instead, so
  // the unread room's badge is genuinely still up when this test starts.
  const otherRoom = { room_id: "!e2e-other:localhost", name: "Other Room", unread_count: 0 };
  const room = { room_id: "!e2e-unread:localhost", name: "Unread E2E Room", unread_count: 3 };
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: otherRoom,
    extraRooms: [room],
  });
  await page.goto("/");

  const roomButton = page.getByRole("button", { name: room.name });
  await expect(roomButton.getByText("3", { exact: true })).toBeVisible();

  await roomButton.click();

  // `mark_room_read` (called on room-becomes-active) zeroes the room's
  // unread state in the mock and re-emits `room_list:update`, mirroring the
  // real sync loop's next-sync-after-receipt-send flow described in the
  // spec.
  await expect(roomButton.getByText("3", { exact: true })).toHaveCount(0);
});

test("a typing indicator appears when another user is typing and disappears when they stop", async ({
  page,
}) => {
  const room = { room_id: "!e2e-typing:localhost", name: "Typing E2E Room", unread_count: 0 };
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room,
  });
  await page.goto("/");
  await page.getByRole("button", { name: room.name }).click();
  await expect(page.getByText("No messages yet")).toBeVisible();

  await page.evaluate(
    ({ roomId, otherUser }) => {
      window.__e2eEmit("typing:update", { room_id: roomId, user_ids: [otherUser] });
    },
    { roomId: room.room_id, otherUser: OTHER_USER },
  );

  await expect(page.getByText(`${OTHER_USER} is typing…`)).toBeVisible();

  await page.evaluate(
    ({ roomId }) => {
      window.__e2eEmit("typing:update", { room_id: roomId, user_ids: [] });
    },
    { roomId: room.room_id },
  );

  await expect(page.getByText(`${OTHER_USER} is typing…`)).toHaveCount(0);
});

test("our own typing is never rendered in the typing row", async ({ page }) => {
  const room = { room_id: "!e2e-own-typing:localhost", name: "Own Typing Room", unread_count: 0 };
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room,
  });
  await page.goto("/");
  await page.getByRole("button", { name: room.name }).click();
  await expect(page.getByText("No messages yet")).toBeVisible();

  await page.evaluate(
    ({ roomId, ownUser }) => {
      window.__e2eEmit("typing:update", { room_id: roomId, user_ids: [ownUser] });
    },
    { roomId: room.room_id, ownUser: USER_ID },
  );

  await expect(page.getByText(/is typing…/)).toHaveCount(0);
});

test("a presence dot renders for a DM room's peer", async ({ page }) => {
  const room = {
    room_id: "!e2e-dm:localhost",
    name: "Bob",
    unread_count: 0,
    is_direct: true,
    dm_peer_user_id: OTHER_USER,
  };
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room,
  });
  await page.goto("/");

  // Wait for the room list (and with it, the root-mounted `usePresenceListener`
  // subscription) to actually render before emitting — firing right after
  // `goto()` resolves races the app's own mount and can drop the update.
  const roomListItem = page.getByRole("button", { name: room.name });
  await expect(roomListItem).toBeVisible();

  await page.evaluate(
    ({ otherUser }) => {
      window.__e2eEmit("presence:update", {
        user_id: otherUser,
        presence: "online",
        status_msg: null,
        last_active_ago_ms: null,
      });
    },
    { otherUser: OTHER_USER },
  );

  // `RoomListItem` renders a `PresenceDot` next to a DM's avatar; the dot
  // itself is `aria-hidden`, with a visually-hidden sibling carrying the
  // real label for assistive tech (see `PresenceDot.tsx`'s doc comment).
  // Scoped to the room-list button itself so this can't be satisfied by the
  // chat header's own (not-yet-rendered) presence dot.
  await expect(roomListItem.getByText("Online", { exact: true })).toBeVisible();

  await roomListItem.click();
  // The chat header shows its own presence dot for the same peer — scoped to
  // the header (identified by the "Show room info" button next to it) so
  // this can't be satisfied by the room-list item's presence label instead.
  const chatHeader = page.getByRole("button", { name: "Show room info" }).locator("..");
  await expect(chatHeader.getByText("Online", { exact: true })).toBeVisible();
});
