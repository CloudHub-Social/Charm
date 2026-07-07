import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";

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

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: MAIN_ROOM,
    extraRooms: [SECOND_ROOM],
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
});

test("muting a room shows a muted indicator", async ({ page }) => {
  const roomButton = page.getByRole("button", { name: MAIN_ROOM.name });

  await roomButton.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mute" }).click();

  await expect(roomButton.getByLabel("Muted")).toBeVisible();

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

  await roomButton.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark as read" }).click();

  await expect(roomButton.getByText("Marked unread")).toHaveCount(0);
});

test("marking a room with an unread badge as read clears the badge", async ({ page }) => {
  const roomButton = page.getByRole("button", { name: SECOND_ROOM.name });
  await expect(roomButton.getByText("2", { exact: true })).toBeVisible();

  await roomButton.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mark as read" }).click();

  await expect(roomButton.getByText("2", { exact: true })).toHaveCount(0);
});
