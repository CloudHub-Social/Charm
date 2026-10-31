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
    const measurePlaceholder = () =>
      paragraph.evaluate((element) => {
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
          whiteSpace: before.whiteSpace,
          overflowWrap: before.overflowWrap,
          overflow: before.overflow,
          textOverflow: before.textOverflow,
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
          placeholderPosition: before.position,
          placeholderLeft: Number.parseFloat(before.left),
          placeholderRight: Number.parseFloat(before.right),
          placeholderWidth: Number.parseFloat(before.width),
          paragraphWidth: rect.width,
          placeholderOverflow: before.overflowX,
          placeholderWhiteSpace: before.whiteSpace,
          placeholderTextOverflow: before.textOverflow,
          bodyWidth: document.documentElement.scrollWidth,
        };
        probe.remove();
        return result;
      });
    const assertContained = (geometry: Awaited<ReturnType<typeof measurePlaceholder>>) => {
      expect(geometry.placeholderContent).toBe(true);
      expect(geometry.placeholderPosition).toBe("absolute");
      expect(geometry.placeholderLeft).toBeGreaterThanOrEqual(0);
      expect(geometry.placeholderRight).toBeGreaterThanOrEqual(0);
      expect(geometry.placeholderLeft + geometry.placeholderWidth).toBeLessThanOrEqual(
        geometry.paragraphWidth + 0.5,
      );
      expect(geometry.placeholderOverflow).toBe("hidden");
      expect(geometry.placeholderWhiteSpace).toBe("nowrap");
      expect(geometry.placeholderTextOverflow).toBe("ellipsis");
      expect(geometry.placeholderProjectedBottom).toBeLessThanOrEqual(geometry.shellBottom);
      expect(geometry.placeholderProjectedBottom).toBeLessThanOrEqual(geometry.viewportHeight);
    };
    assertContained(await measurePlaceholder());
    await captureSnapshot(page, `composer-geometry-${refresh ? "refreshed" : "legacy"}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(paragraph).toBeVisible();
    assertContained(await measurePlaceholder());
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.setViewportSize({ width: 768, height: 1024 });
    await expect(page.getByRole("button", { name: "Attach" })).toBeVisible();
    await editor.click();
    await expect(editor).toBeFocused();
    const measureCaret = (allowEmptyFallback: boolean) =>
      editor.evaluate((element, allowFallback) => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount !== 1) throw new Error("Editor selection is absent");
        if (!selection.isCollapsed || !element.contains(selection.anchorNode)) {
          throw new Error("Editor does not own a collapsed selection");
        }
        const rangeBounds = selection.getRangeAt(0).getBoundingClientRect();
        // Chromium can return an empty rectangle for the caret in an empty
        // contenteditable paragraph. Its break element represents that line.
        const emptyLine = allowFallback ? element.querySelector("p br") : null;
        const caret = rangeBounds.height > 0 ? rangeBounds : emptyLine?.getBoundingClientRect();
        if (!caret || caret.height <= 0) throw new Error("Editor caret line is not measurable");
        const editorBounds = element.getBoundingClientRect();
        const shell = element.closest('[data-testid="composer-shell"]')!.getBoundingClientRect();
        return {
          caretTop: caret.top,
          caretLeft: caret.left,
          caretHeight: caret.height,
          editorTop: editorBounds.top,
          editorHeight: editorBounds.height,
          shellHeight: shell.height,
        };
      }, allowEmptyFallback);
    const empty = await measureCaret(true);
    await page.keyboard.type("x");
    const typed = await measureCaret(false);
    expect(empty.caretHeight).toBeGreaterThan(0);
    expect(typed.caretHeight).toBeGreaterThan(0);
    expect(Math.abs(typed.caretTop - empty.caretTop)).toBeLessThanOrEqual(5);
    expect(typed.caretLeft).toBeGreaterThan(empty.caretLeft);
    expect(Math.abs(typed.editorTop - empty.editorTop)).toBeLessThanOrEqual(1);
    expect(Math.abs(typed.editorHeight - empty.editorHeight)).toBeLessThanOrEqual(1);
    expect(Math.abs(typed.shellHeight - empty.shellHeight)).toBeLessThanOrEqual(1);
    await captureSnapshot(page, `composer-geometry-typed-${refresh ? "refreshed" : "legacy"}`);
    await editor.fill("synthetic draft retains focus");
    await expect(editor).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(editor).toContainText("synthetic draft retains focus");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
  });
}
