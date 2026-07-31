import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

/**
 * Spec 19 Phase 4 coverage: the space rail's "+" entry point opens the
 * create/join dialog, and both the create-a-new-space and join-by-address
 * flows land the user in the new/joined space via the real IPC round trip
 * (against the fake backend's `create_space`/`join_room` handlers — see
 * `mockTauri.ts`).
 */

const USER_ID = "@e2e:localhost";
const HOME_ROOM_ID = "!space-create-join-home:e2e";

test("creates a new space and switches into it", async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: { room_id: HOME_ROOM_ID, name: "Home base", unread_count: 0 },
  });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await page.getByRole("button", { name: "Create or join space" }).click();

  await expect(page.getByRole("heading", { name: "Create or join a space" })).toBeVisible();
  await page.getByLabel("Name").fill("Engineering");
  await page.getByRole("button", { name: "Create space" }).click();

  await expect(page.getByRole("heading", { name: "Engineering" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create or join a space" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Engineering", exact: true })).toBeVisible();
  await captureSnapshot(page, "space-create-join-created");
});

test("creates a new space beneath the selected parent", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({
        state: { overrides: { space_hierarchy_reorganization: true } },
        updatedAt: Date.now(),
      }),
    );
  });
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: {
      room_id: HOME_ROOM_ID,
      name: "Team",
      unread_count: 0,
      is_space: true,
    },
  });
  await page.goto("/");

  const teamButton = page.getByRole("button", { name: "Team", exact: true });
  await teamButton.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Create subspace" }).click();

  await expect(page.getByRole("heading", { name: "Create or join a space" })).toBeVisible();
  await page.getByLabel("Name").fill("Research");
  await page.getByRole("button", { name: "Create space" }).click();

  await expect(page.getByRole("heading", { name: "Research" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Research", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Collapse Team" })).toBeVisible();
  await captureSnapshot(page, "space-hierarchy-create-subspace");
});

test("drags one space beneath another and refreshes the rail hierarchy", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({
        state: { overrides: { space_hierarchy_reorganization: true } },
        updatedAt: Date.now(),
      }),
    );
  });
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: {
      room_id: "!alpha:e2e",
      name: "Alpha",
      unread_count: 0,
      is_space: true,
    },
    extraRooms: [
      {
        room_id: "!beta:e2e",
        name: "Beta",
        unread_count: 0,
        is_space: true,
      },
    ],
  });
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => window.__e2eListenerCount("room_list:update")))
    .toBeGreaterThan(0);

  const alpha = page.getByRole("button", { name: "Alpha", exact: true });
  const beta = page.getByRole("button", { name: "Beta", exact: true });
  for (const space of [alpha, beta]) {
    await space.click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Move to space…" })).toBeEnabled();
    await page.keyboard.press("Escape");
  }
  const alphaBox = await alpha.boundingBox();
  const betaBox = await beta.boundingBox();
  expect(alphaBox).not.toBeNull();
  expect(betaBox).not.toBeNull();
  if (!alphaBox || !betaBox) throw new Error("space rail entries did not render");

  await page.mouse.move(alphaBox.x + alphaBox.width / 2, alphaBox.y + alphaBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(betaBox.x + betaBox.width / 2, betaBox.y + betaBox.height / 2, {
    steps: 6,
  });
  await expect(beta).toHaveClass(/ring-2/);
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.__e2eSetSpaceParentCalls))
    .toEqual([{ spaceId: "!alpha:e2e", parentSpaceId: "!beta:e2e" }]);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const rooms = (await window.__TAURI_INTERNALS__.invoke("list_rooms")) as Array<{
          room_id: string;
          parent_space_ids: string[];
        }>;
        return rooms.find((room) => room.room_id === "!alpha:e2e")?.parent_space_ids;
      }),
    )
    .toEqual(["!beta:e2e"]);
  await page.evaluate(async () => {
    const rooms = await window.__TAURI_INTERNALS__.invoke("list_rooms");
    window.__e2eEmit("room_list:update", rooms);
  });

  await expect(page.getByRole("button", { name: "Expand Beta" })).toBeVisible();
  await page.getByRole("button", { name: "Expand Beta" }).click();
  await expect(page.getByRole("button", { name: "Alpha", exact: true })).toBeVisible();
  await captureSnapshot(page, "space-hierarchy-drag-to-nest");
});

test("opens a space in the shared settings shell", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({
        state: { overrides: { space_hierarchy_reorganization: true } },
        updatedAt: Date.now(),
      }),
    );
  });
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: {
      room_id: "!community:e2e",
      name: "Community",
      unread_count: 0,
      is_space: true,
    },
    roomDetails: {
      room_id: "!community:e2e",
      name: "Community",
    },
    extraRooms: [
      { room_id: "!project:e2e", name: "Project", unread_count: 0 },
      { room_id: "!safe:e2e", name: "Safe room", unread_count: 0 },
    ],
    spaceChildren: {
      "!community:e2e": [
        {
          room_id: "!project:e2e",
          name: "Project",
          topic: "Planning",
          num_joined_members: 4,
          join_rule: "invite",
          is_space: false,
        },
      ],
    },
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Community", exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Settings" }).click();

  await expect(page.getByRole("dialog", { name: "Space settings" })).toBeVisible();
  await expect(page.getByLabel("Space name")).toHaveValue("Community");
  await expect(page.getByText("Encryption")).toHaveCount(0);
  await captureSnapshot(page, "space-settings-general");
  await page.getByRole("tab", { name: "Children" }).click();
  const childrenPanel = page.getByRole("tabpanel", { name: "Children" });
  await expect(childrenPanel.getByText("Project", { exact: true })).toBeVisible();
  await childrenPanel.getByRole("button", { name: "Remove Project" }).click();
  await expect(childrenPanel.getByText("This space has no published children.")).toBeVisible();

  await childrenPanel.getByRole("button", { name: "Add existing" }).click();
  await page.getByRole("button", { name: /Safe room/ }).click();
  await expect(childrenPanel.getByText("Safe room", { exact: true })).toBeVisible();
  await captureSnapshot(page, "space-settings-child-management");
});

test("joins a space by address and switches into it", async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: { room_id: HOME_ROOM_ID, name: "Home base", unread_count: 0 },
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Create or join space" }).click();
  await expect(page.getByRole("heading", { name: "Create or join a space" })).toBeVisible();

  const joinTab = page.getByRole("tab", { name: "Join by address" });
  await joinTab.click();
  await page.getByLabel("Space address").fill("#design-team:e2e");
  await page.getByRole("button", { name: "Join space" }).click();

  await expect(page.getByRole("heading", { name: "#design-team:e2e" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create or join a space" })).toHaveCount(0);
});

test("shows an inline error and stays open when creation fails", async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: { room_id: HOME_ROOM_ID, name: "Home base", unread_count: 0 },
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Create or join space" }).click();
  await page.getByRole("button", { name: "Create space" }).click();

  await expect(page.getByText("Name is required.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create or join a space" })).toBeVisible();
});
