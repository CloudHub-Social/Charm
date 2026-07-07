import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";

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
