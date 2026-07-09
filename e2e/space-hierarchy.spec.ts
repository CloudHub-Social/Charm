import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

/**
 * Spec 19 Phase 2 coverage: the space rail is separate from the room list,
 * selecting a space scopes the list to the recursive hierarchy, and Phase 1's
 * space badge rollups are consumed by the rail/header UI.
 */

const USER_ID = "@e2e:localhost";
const ROOT_SPACE_ID = "!space-root:e2e";
const SUB_SPACE_ID = "!space-sub:e2e";
const DIRECT_ROOM_ID = "!space-direct:e2e";
const NESTED_ROOM_ID = "!space-nested:e2e";

const subSpaceChild = {
  room_id: SUB_SPACE_ID,
  name: "Product",
  topic: null,
  num_joined_members: 2,
  join_rule: "invite",
  is_space: true,
};

const directRoomChild = {
  room_id: DIRECT_ROOM_ID,
  name: "Announcements",
  topic: null,
  num_joined_members: 4,
  join_rule: "public",
  is_space: false,
};

const nestedRoomChild = {
  room_id: NESTED_ROOM_ID,
  name: "Planning",
  topic: null,
  num_joined_members: 2,
  join_rule: "public",
  is_space: false,
};

test("renders nested space rooms and exposes recursive hierarchy plus space badge rollups", async ({
  page,
}) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: { room_id: ROOT_SPACE_ID, name: "Team Space", unread_count: 0, is_space: true },
    extraRooms: [
      {
        room_id: SUB_SPACE_ID,
        name: "Product",
        is_space: true,
        parent_space_ids: [ROOT_SPACE_ID],
      },
      {
        room_id: DIRECT_ROOM_ID,
        name: "Announcements",
        parent_space_ids: [ROOT_SPACE_ID],
      },
      {
        room_id: NESTED_ROOM_ID,
        name: "Planning",
        unread_count: 3,
        unread_messages: 3,
        has_unread: true,
        parent_space_ids: [SUB_SPACE_ID],
      },
    ],
    spaceChildren: {
      [ROOT_SPACE_ID]: [subSpaceChild, directRoomChild],
      [SUB_SPACE_ID]: [nestedRoomChild],
    },
    spaceHierarchy: {
      [ROOT_SPACE_ID]: [
        { child: subSpaceChild, children: [{ child: nestedRoomChild, children: [] }] },
        { child: directRoomChild, children: [] },
      ],
    },
  });
  await page.goto("/");

  const hierarchy = await page.evaluate(
    (spaceId) => window.__TAURI_INTERNALS__.invoke("list_space_hierarchy", { spaceId }),
    ROOT_SPACE_ID,
  );
  expect(hierarchy).toEqual([
    { child: subSpaceChild, children: [{ child: nestedRoomChild, children: [] }] },
    { child: directRoomChild, children: [] },
  ]);

  await expect(page.getByRole("navigation", { name: "Spaces" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Team Space", exact: true })).toBeVisible();
  await expect(page.getByText("Planning")).toHaveCount(0);

  await page.getByRole("button", { name: "Team Space", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Team Space" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Space rooms/ })).toBeVisible();
  await expect(page.getByText("Product", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Announcements" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Planning" }).getByText("3")).toBeVisible();

  await page.evaluate((payload) => window.__e2eEmit("badge:update", payload), {
    total_unread: 1,
    total_highlight: 3,
    spaces: {
      [ROOT_SPACE_ID]: { total_unread: 1, total_highlight: 3 },
      [SUB_SPACE_ID]: { total_unread: 1, total_highlight: 3 },
    },
  });

  await expect(page.getByLabel("1 unread rooms, 3 mentions")).toHaveText("3");
  await captureSnapshot(page, "space-hierarchy-foundation");
});
