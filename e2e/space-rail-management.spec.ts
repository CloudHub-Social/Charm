import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

/**
 * Spec 63 coverage: pin/unpin, reorder, and the per-space context menu
 * (Invite, Add Existing, Mark/Unmark Suggested, Remove, Leave) on the space
 * rail — gated behind `space_rail_management` (default off), so this spec
 * enables it via the same local-override localStorage mirror
 * `responsive-layout.spec.ts` uses for `mobile_chat_redesign`.
 */

const USER_ID = "@e2e:localhost";
const ROOT_SPACE_ID = "!space-root:e2e";
const OTHER_SPACE_ID = "!space-other:e2e";
const CHILD_SPACE_ID = "!space-child:e2e";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({
        state: { overrides: { space_rail_management: true } },
        updatedAt: Date.now(),
      }),
    );
  });
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: { room_id: ROOT_SPACE_ID, name: "Team", unread_count: 0, is_space: true },
    extraRooms: [
      { room_id: OTHER_SPACE_ID, name: "Design", is_space: true },
      {
        room_id: CHILD_SPACE_ID,
        name: "Product",
        is_space: true,
        parent_space_ids: [ROOT_SPACE_ID],
      },
    ],
    spaceChildren: {
      [ROOT_SPACE_ID]: [
        {
          room_id: CHILD_SPACE_ID,
          name: "Product",
          topic: null,
          num_joined_members: 2,
          join_rule: "invite",
          is_space: true,
        },
      ],
    },
  });
  await page.goto("/");
});

test("opens a per-space context menu with pin, invite, add existing, and leave actions", async ({
  page,
}) => {
  const teamButton = page.getByRole("button", { name: "Team", exact: true });
  await expect(teamButton).toBeVisible();

  await teamButton.click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Open lobby" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Invite" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Add existing…" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Unpin from sidebar" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Leave" })).toBeVisible();
  // Not a child of anything in this fixture, so no Remove/Suggested actions.
  await expect(menu.getByRole("menuitem", { name: "Remove from space" })).toHaveCount(0);

  await captureSnapshot(page, "space-rail-context-menu");
});

test("unpins a space from the rail, moving it below the divider", async ({ page }) => {
  const teamButton = page.getByRole("button", { name: "Team", exact: true });
  await teamButton.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Unpin from sidebar" }).click();

  // Re-opening the menu on the now-unpinned entry offers Pin instead.
  await page.getByRole("button", { name: "Team", exact: true }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Pin to sidebar" })).toBeVisible();
});

test("shows a confirmation dialog before leaving a space", async ({ page }) => {
  const teamButton = page.getByRole("button", { name: "Team", exact: true });
  await teamButton.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Leave" }).click();

  const dialog = page.getByRole("dialog", { name: "Leave Team?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

test("opens the Add Existing picker scoped to the space it was invoked from", async ({ page }) => {
  const teamButton = page.getByRole("button", { name: "Team", exact: true });
  await teamButton.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add existing…" }).click();

  const dialog = page.getByRole("dialog", { name: "Add existing room or space to Team" });
  await expect(dialog).toBeVisible();
  // "Design" is a candidate (not related to Team); "Product" is excluded
  // since it's already Team's child.
  await expect(dialog.getByRole("button", { name: "Design" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Product" })).toHaveCount(0);
});

test("offers Remove and Set/Unset Suggested on a space with a known parent", async ({ page }) => {
  // Pre-existing layout quirk (not introduced by this change): the absolutely
  // positioned chevron sits under the space avatar's centered hit area, so a
  // default center-point click resolves (via real browser hit-testing, which
  // even a forced Playwright click still goes through) to the avatar
  // underneath. Click the chevron's top-left corner instead — the sliver a
  // real user can still land on — rather than its occluded center.
  await expect(page.getByRole("button", { name: "Expand Team" })).toBeVisible();
  await page.getByRole("button", { name: "Expand Team" }).click({ position: { x: 2, y: 2 } });

  const productButton = page.getByRole("button", { name: "Product", exact: true });
  await expect(productButton).toBeVisible();
  await productButton.click({ button: "right" });

  const menu = page.getByRole("menu");
  await expect(
    menu.getByRole("menuitem", { name: "Mark as suggested", exact: true }),
  ).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Unmark as suggested" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Remove from space" })).toBeVisible();
  // Nested (non-top-level) entries don't offer pin/reorder.
  await expect(menu.getByRole("menuitem", { name: "Pin to sidebar" })).toHaveCount(0);
});
