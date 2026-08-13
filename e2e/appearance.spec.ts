import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

/**
 * Substitute for the spec's native Playwright+tauri-driver boot-flash test
 * (no real Tauri driver available in this harness — see CLAUDE.md). Rather
 * than a screenshot-diff of the first native frame, this verifies the same
 * underlying mechanism: `index.html`'s inline boot script reads the
 * localStorage mirror and sets `data-theme`/`data-density`/`data-font-size`/
 * `data-reduced-motion` on `<html>` synchronously, before the app's module
 * bundle (and therefore before React) ever runs. We seed the mirror via
 * `addInitScript` (so it exists before any page script, matching how the
 * real localStorage mirror would already be populated from a previous
 * session) and assert the attribute is present immediately on navigation —
 * proving the boot script ran ahead of the bundle rather than theme being
 * applied later by `ThemeProvider`'s reconcile effect.
 *
 * snapshot-exempt: asserts `data-theme`/`data-density`/etc attributes on `<html>`
 * before paint, not visible pixel state — there is nothing a screenshot would
 * meaningfully capture here that the attribute assertions don't already cover.
 */

const ROOM = { room_id: "!e2e-appearance:localhost", name: "Appearance E2E Room", unread_count: 0 };
const USER_ID = "@e2e:localhost";

function seedAppearanceMirror(appearance: Record<string, string>) {
  localStorage.setItem("charm:appearance", JSON.stringify(appearance));
}

test("boot script applies a persisted non-default theme before the app bundle runs", async ({
  page,
}) => {
  await page.addInitScript(seedAppearanceMirror, {
    theme: "midnight",
    fontSize: "lg",
    density: "compact",
    reducedMotion: "on",
  });
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
  });

  await page.goto("/");

  // Checked before waiting on any React-rendered content: the boot script
  // runs synchronously in <head>, so the attribute must already be correct
  // the instant the DOM exists — not merely "eventually consistent" once
  // React mounts and ThemeProvider reconciles.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
  await expect(page.locator("html")).toHaveAttribute("data-font-size", "lg");
  await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "on");

  // And it survives into the fully-rendered app rather than being clobbered
  // by a default-theme reconcile once the bundle takes over.
  await expect(page.getByRole("button", { name: ROOM.name })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "midnight");
});

test("defaults to dark when no appearance has been persisted", async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
  });

  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("group DMs use composite avatars and the persisted ring-or-dot preference", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({
        state: { overrides: { avatar_presence_visuals: true } },
        updatedAt: Date.now(),
      }),
    );
  });
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
    extraRooms: [
      {
        room_id: "!group-dm:localhost",
        name: "Alice, Bob, Carol",
        is_direct: true,
        group_dm_members: [
          { user_id: "@alice:localhost", display_name: "Alice", avatar_url: null },
          { user_id: "@bob:localhost", display_name: "Bob", avatar_url: null },
          { user_id: "@carol:localhost", display_name: "Carol", avatar_url: null },
        ],
      },
    ],
  });

  await page.goto("/");
  const groupRow = page.getByRole("button", { name: /Alice, Bob, Carol/ });
  await expect(groupRow.locator("[data-group-dm-avatar]")).toBeVisible();
  await expect(groupRow.locator("[data-group-dm-avatar] [data-slot='avatar']")).toHaveCount(3);

  await expect
    .poll(() => page.evaluate(() => window.__e2eListenerCount("presence:update")))
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    window.__e2eEmit("presence:update", {
      user_id: "@alice:localhost",
      presence: "online",
      status_msg: null,
      last_active_ago_ms: null,
    });
  });
  await expect(groupRow.getByText("Online group presence")).toBeVisible();
  await captureSnapshot(page, "avatar-presence-group-dm");

  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("tab", { name: "Appearance" }).click();
  const ringToggle = page.getByRole("switch", { name: "Show group DM presence rings" });
  await expect(ringToggle).toBeChecked();
  await ringToggle.click();
  await expect(ringToggle).not.toBeChecked();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(groupRow.getByText("Online", { exact: true })).toBeVisible();
});

test("boot script falls back to defaults for a corrupted-but-parseable persisted value", async ({
  page,
}) => {
  // Valid JSON, invalid enum values — e.g. a hand-edited localStorage entry
  // or a store file from an incompatible build. The boot script must
  // validate against its allowed-value lists rather than accepting these
  // verbatim (which would set e.g. data-theme="banana", matching no CSS
  // override and silently breaking theming).
  await page.addInitScript(seedAppearanceMirror, {
    theme: "banana",
    fontSize: "huge",
    density: "spacious",
    reducedMotion: "maybe",
  });
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
  });

  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-density", "cozy");
  await expect(page.locator("html")).toHaveAttribute("data-font-size", "md");
  await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "system");
});
