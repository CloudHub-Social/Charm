import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

/**
 * End-to-end coverage of Spec 06's context-menu room-organization actions
 * (favourite / low-priority / mute / mark-unread / mark-read) and their
 * effect on section placement and indicators — against the real app UI with
 * Tauri IPC faked in-browser (see `support/mockTauri.ts`).
 *
 * Scoping note (drag reorder): `RoomList.tsx`'s manual drag reorder is
 * driven by `@use-gesture/react`'s pointer-move deltas translated into a
 * fractional `TagInfo.order` via `planManualReorder`. Simulating a
 * `@use-gesture` drag reliably through Playwright's synthetic pointer
 * events is fiddly (the gesture lib listens for raw pointer events with
 * specific timing/movement thresholds, and small differences in how
 * Playwright dispatches synthetic pointer moves are a known source of
 * flakiness for this kind of library across the ecosystem) and the
 * reordering math (`planManualReorder`'s midpoint computation) already has
 * direct unit coverage. So drag-reorder itself is **not** covered here —
 * this suite covers context-menu actions solidly instead, which is where
 * the acceptance criteria's section-placement and indicator behavior
 * actually lives.
 */

const USER_ID = "@e2e:localhost";
const MAIN_ROOM = { room_id: "!e2e-org-main:localhost", name: "Main Room", unread_count: 0 };
const SECOND_ROOM = { room_id: "!e2e-org-second:localhost", name: "Second Room", unread_count: 2 };
const AMBIENT_ROOM = {
  room_id: "!e2e-org-ambient:localhost",
  name: "Ambient Room",
  unread_count: 0,
  unread_messages: 7,
  has_unread: true,
};
const PREVIEW_ROOM = {
  room_id: "!e2e-org-preview:localhost",
  name: "Preview Room",
  unread_count: 0,
  last_message_preview: {
    sender_id: "@alex:localhost",
    sender_display_name: "Alex",
    text: "Sounds good, see you at the coffee shop tomorrow!",
  },
};

test.beforeEach(async ({ page }, testInfo) => {
  const extraRooms = testInfo.title.includes("ambient unread message totals")
    ? [SECOND_ROOM, AMBIENT_ROOM]
    : testInfo.title.includes("last-message preview")
      ? [SECOND_ROOM, PREVIEW_ROOM]
      : [SECOND_ROOM];
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: MAIN_ROOM,
    extraRooms,
  });
  await page.goto("/");
});

test("favouriting a room via its context menu moves it into the Favourites section", async ({
  page,
}) => {
  const roomButton = page.getByRole("button", { name: MAIN_ROOM.name });
  // The Favourites section is entirely absent (renders `null`) until it has
  // at least one room — see `RoomListSection`'s `count === 0` early return.
  await expect(page.getByText("Favourites")).toHaveCount(0);

  await roomButton.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add to Favourites" }).click();

  // Section header now renders with a count of 1.
  const favouritesHeader = page.getByRole("button", { name: /Favourites/ });
  await expect(favouritesHeader).toBeVisible();
  await expect(favouritesHeader.getByText("1", { exact: true })).toBeVisible();
  await captureSnapshot(page, "room-list-org-favourited");

  // Toggling back removes it from Favourites (label flips).
  await roomButton.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Remove from Favourites" })).toBeVisible();
});

test("marking a room low-priority moves it to the Low priority section and clears favourite", async ({
  page,
}) => {
  const roomButton = page.getByRole("button", { name: MAIN_ROOM.name });

  await roomButton.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add to Favourites" }).click();

  await roomButton.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to Low priority" }).click();

  // A room can't be both favourite and low-priority — the mock's
  // `set_room_low_priority` clears the favourite tag, mirroring the real
  // Rust command's mutual-exclusion behavior (spec acceptance criterion 2).
  await roomButton.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Add to Favourites" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Remove from Low priority" })).toBeVisible();
  await captureSnapshot(page, "room-list-org-low-priority");
});

test("muting a room shows a muted indicator", async ({ page }) => {
  const roomButton = page.getByRole("button", { name: MAIN_ROOM.name });

  await roomButton.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mute" }).click();

  await expect(roomButton.getByLabel("Muted")).toBeVisible();
  await captureSnapshot(page, "room-list-org-muted");

  await roomButton.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Unmute" })).toBeVisible();
});

test("marking a room unread shows the mark-unread dot even with zero unread messages", async ({
  page,
}) => {
  const roomButton = page.getByRole("button", { name: MAIN_ROOM.name });

  await roomButton.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark as unread" }).click();

  await expect(roomButton.getByText("Marked unread")).toBeVisible();

  // The "Mark as read" context-menu action calls `markRoomRead`, which —
  // both in the real Rust command and this mock — only sends a read
  // receipt/fully-read marker. It does not clear the separate MSC2867
  // `m.marked_unread` flag (only `setRoomMarkedUnread` does that), so the
  // dot set above is unaffected by it.
  await roomButton.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark as read" }).click();

  await expect(roomButton.getByText("Marked unread")).toBeVisible();
  await captureSnapshot(page, "room-list-org-marked-unread");
});

test("marking a room with an unread badge as read clears the badge", async ({ page }) => {
  const roomButton = page.getByRole("button", { name: SECOND_ROOM.name });
  await expect(roomButton.getByText("2", { exact: true })).toBeVisible();

  await roomButton.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark as read" }).click();

  await expect(roomButton.getByText("2", { exact: true })).toHaveCount(0);
  await captureSnapshot(page, "room-list-org-marked-read");
});

test("filters to unread rooms and restores the persisted choice after reload", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({
        state: { overrides: { room_list_unread_filter: true } },
        updatedAt: Date.now(),
      }),
    );
  });
  await page.reload();

  const filter = page.getByRole("group", { name: "Room filter" });
  const unreadButton = filter.getByRole("button", { name: "Unread", exact: true });
  const secondRoomButton = page.getByRole("button", { name: new RegExp(SECOND_ROOM.name) });

  // Move the active-room exception to Second Room. Opening it marks its
  // numeric unread count read, so its continued visibility below proves the
  // active-room retention rule independently of the unread predicate.
  await secondRoomButton.click();
  await expect(page.getByPlaceholder(`Message ${SECOND_ROOM.name}`)).toBeVisible();

  await unreadButton.click();

  await expect(unreadButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: MAIN_ROOM.name })).toHaveCount(0);
  await expect(secondRoomButton).toBeVisible();
  await captureSnapshot(page, "room-list-org-unread-filter");

  await page.reload();

  const reloadedFilter = page.getByRole("group", { name: "Room filter" });
  await expect(reloadedFilter.getByRole("button", { name: "Unread", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: MAIN_ROOM.name })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(SECOND_ROOM.name) })).toBeVisible();
});

test("shows ambient unread message totals when enabled in Appearance", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({
        state: { overrides: { room_list_unread_filter: true } },
        updatedAt: Date.now(),
      }),
    );
  });
  await page.reload();

  const roomButton = page.getByRole("button", { name: new RegExp(AMBIENT_ROOM.name) });
  await expect(roomButton.getByText("Unread", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("tab", { name: "Appearance" }).click();
  await page.getByRole("switch", { name: "Show unread message counts" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();

  await expect(roomButton.getByLabel("7 unread messages")).toHaveText("7");
});

test("shows the last-message preview with sender label when enabled", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({
        state: { overrides: { room_list_message_preview: true } },
        updatedAt: Date.now(),
      }),
    );
  });
  await page.reload();

  const roomButton = page.getByRole("button", { name: new RegExp(PREVIEW_ROOM.name) });
  await expect(roomButton.getByText("Alex:", { exact: false })).toBeVisible();
  await expect(
    roomButton.getByText("Sounds good, see you at the coffee shop tomorrow!"),
  ).toBeVisible();
  await captureSnapshot(page, "room-list-org-message-preview");
});

test("switching to Unread first reorders the room list and persists after reload", async ({
  page,
}) => {
  await page.evaluate(() => {
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({
        state: { overrides: { room_list_sort: true } },
        updatedAt: Date.now(),
      }),
    );
  });
  await page.reload();

  const roomButtons = () =>
    page.getByRole("button", { name: new RegExp(`${MAIN_ROOM.name}|${SECOND_ROOM.name}`) });
  const sortSelect = page.getByLabel("Sort");

  // Default order is alphabetical ("Main Room", "Second Room"); Second Room
  // carries an unread count from the fixture above.
  await expect(sortSelect).toHaveValue("default");
  await expect(roomButtons().nth(0)).toHaveText(new RegExp(MAIN_ROOM.name));
  await expect(roomButtons().nth(1)).toHaveText(new RegExp(SECOND_ROOM.name));

  await sortSelect.selectOption("unread");

  await expect(roomButtons().nth(0)).toHaveText(new RegExp(SECOND_ROOM.name));
  await expect(roomButtons().nth(1)).toHaveText(new RegExp(MAIN_ROOM.name));
  await captureSnapshot(page, "room-list-org-unread-sort");

  await page.reload();

  await expect(page.getByLabel("Sort")).toHaveValue("unread");
  await expect(roomButtons().nth(0)).toHaveText(new RegExp(SECOND_ROOM.name));
  await expect(roomButtons().nth(1)).toHaveText(new RegExp(MAIN_ROOM.name));
});
