import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

for (const refresh of [false, true]) {
  test(`inspect long composer placeholder geometry (refresh=${refresh})`, async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.addInitScript(installMockTauri, {
      userId: "@geometry:example.org",
      deviceId: "COMPOSER_GEOMETRY",
      room: {
        room_id: "!geometry:example.org",
        name: "A deliberately long room name for responsive header geometry and truncation",
        unread_count: 0,
      },
    });
    await page.addInitScript((enabled) => {
      localStorage.setItem(
        "charm:featureFlags",
        JSON.stringify({ state: { overrides: { ux_refresh_v1: enabled } }, updatedAt: Date.now() }),
      );
    }, refresh);
    await page.goto("/");
    await page.getByRole("button", { name: /A deliberately long room name/ }).click();
    const editor = page.locator('[contenteditable="true"]').first();
    await expect(editor).toHaveAttribute("aria-label", /Message A deliberately long room name/);
    const paragraph = editor.locator("p.is-editor-empty");
    await expect(paragraph).toBeVisible();
    const geometry = await paragraph.evaluate((element) => {
      const before = getComputedStyle(element, "::before");
      const rect = element.getBoundingClientRect();
      const probe = document.createElement("span");
      const style = getComputedStyle(element);
      Object.assign(probe.style, {
        position: "fixed",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        font: style.font,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        whiteSpace: style.whiteSpace,
        overflowWrap: style.overflowWrap,
        visibility: "hidden",
      });
      probe.textContent = element.getAttribute("data-placeholder");
      document.body.append(probe);
      const probeRect = probe.getBoundingClientRect();
      const shell = element.closest('[data-testid="composer-shell"]')!.getBoundingClientRect();
      const result = {
        viewportHeight: window.innerHeight,
        editorTop: rect.top,
        editorBottom: rect.bottom,
        shellBottom: shell.bottom,
        placeholderProjectedBottom: probeRect.bottom,
        placeholderFloat: before.float,
        placeholderHeight: before.height,
        placeholderContent: Boolean(element.getAttribute("data-placeholder")),
        bodyWidth: document.documentElement.scrollWidth,
      };
      probe.remove();
      return result;
    });
    // Diagnostic values are synthetic and are retained in hosted CI logs.
    // eslint-disable-next-line no-console
    console.log(`COMPOSER_GEOMETRY ${JSON.stringify({ refresh, ...geometry })}`);
    expect(geometry.placeholderContent).toBe(true);
    await captureSnapshot(page, `composer-geometry-${refresh ? "refreshed" : "legacy"}`);
    await page.addStyleTag({
      content:
        ".tiptap.ProseMirror p.is-editor-empty:first-child::before { height: auto; width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }",
    });
    const constrained = await paragraph.evaluate((element) => {
      const before = getComputedStyle(element, "::before");
      const rect = element.getBoundingClientRect();
      return {
        viewportHeight: window.innerHeight,
        paragraphBottom: rect.bottom,
        pseudoHeight: before.height,
        pseudoWidth: before.width,
        whiteSpace: before.whiteSpace,
        overflow: before.overflow,
      };
    });
    // Diagnostic values are synthetic and are retained in hosted CI logs.
    // eslint-disable-next-line no-console
    console.log(`COMPOSER_GEOMETRY_CONSTRAINED ${JSON.stringify({ refresh, ...constrained })}`);
    await captureSnapshot(
      page,
      `composer-geometry-constrained-${refresh ? "refreshed" : "legacy"}`,
    );
    await expect(page.getByRole("button", { name: "Attach" })).toBeVisible();
    await editor.fill("synthetic draft retains focus");
    await expect(editor).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(editor).toContainText("synthetic draft retains focus");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
  });
}
