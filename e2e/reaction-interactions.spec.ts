import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

const ROOM = { room_id: "!reactions:example.org", name: "Reaction fixtures", unread_count: 0 };
const USER = "@reactor:example.org";
const EMOJI = [
  "👍",
  "🎉",
  "❤️",
  "🔥",
  "👀",
  "✅",
  "🌟",
  "🎈",
  "💜",
  "😊",
  "🙌",
  "🚀",
  "🍀",
  "☀️",
  "🌈",
  "🎵",
  "💡",
  "👏",
  "🤔",
  "💯",
];

for (const layout of ["bubble", "discord", "irc"]) {
  for (const width of [320, 375, 430, 1280]) {
    for (const count of [1, 5, 20]) {
      test(`${layout} ${width}px wraps ${count} reaction targets and separates details from toggles`, async ({
        page,
      }) => {
        // Select the room through the desktop list before exercising compact
        // rendering; mobile navigation is owned by the shell lane.
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.addInitScript(
          ({ messageLayout }) => {
            localStorage.setItem(
              "charm:featureFlags",
              JSON.stringify({
                state: { overrides: { message_action_parity: true } },
                updatedAt: Date.now(),
              }),
            );
            localStorage.setItem(
              "charm:appearance",
              JSON.stringify({ state: { messageLayout }, updatedAt: Date.now() }),
            );
          },
          { messageLayout: layout },
        );
        await page.addInitScript(installMockTauri, {
          userId: USER,
          deviceId: "REACTION_FIXTURE",
          room: ROOM,
          initialMessages: [
            {
              event_id: "$reactions",
              sender: USER,
              sender_display_name: null,
              sender_avatar_url: null,
              sender_avatar_path: null,
              body: "Synthetic reaction message",
              formatted_body: null,
              timestamp_ms: 1793059200000,
              edited: false,
              redacted: false,
              reactions: EMOJI.slice(0, count).map((key) => ({
                key,
                count: 1,
                reacted_by_me: true,
              })),
              in_reply_to: null,
              transaction_id: null,
              send_state: { state: "sent" },
            },
          ],
        });
        await page.goto("/");
        await page.getByRole("button", { name: ROOM.name }).click();
        await expect(page.getByText("Synthetic reaction message", { exact: true })).toBeVisible();
        if (layout === "bubble" && width === 320 && count === 1) {
          await page.evaluate(() => {
            const state = { commands: [] as string[], focus: [] as string[] };
            (window as unknown as { reactionDiagnostics: typeof state }).reactionDiagnostics =
              state;
            const invoke = window.__TAURI_INTERNALS__.invoke;
            window.__TAURI_INTERNALS__.invoke = async (command, args) => {
              if (command === "toggle_reaction") state.commands.push(JSON.stringify(args));
              return invoke(command, args);
            };
            document.addEventListener("focusin", (event) => {
              const target = event.target as HTMLElement;
              state.focus.push(
                `${target.tagName}:${target.getAttribute("aria-label")}:${target.textContent?.slice(0, 60)}`,
              );
            });
          });
        }
        await page.setViewportSize({ width, height: 900 });
        const bar = page.getByRole("group", { name: "Reactions", exact: true });
        await expect(bar).toBeVisible();
        const chips = bar.locator("button[aria-pressed]");
        await expect(chips).toHaveCount(count);
        // Capture after responsive layout settles, before measuring all targets.
        await captureSnapshot(page, `reactions-${layout}-${width}-${count}`);
        const targets = await bar
          .locator('button[aria-pressed], button[aria-label="Add reaction"]')
          .evaluateAll((buttons) =>
            buttons.map((button) => {
              const rect = button.getBoundingClientRect();
              return {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                right: rect.right,
                bottom: rect.bottom,
              };
            }),
          );
        const bounds = await bar.boundingBox();
        expect(bounds).not.toBeNull();
        for (const target of targets) {
          expect(target.width).toBeGreaterThanOrEqual(44);
          expect(target.height).toBeGreaterThanOrEqual(44);
          expect(target.x).toBeGreaterThanOrEqual(bounds!.x - 1);
          expect(target.right).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
          expect(target.right).toBeLessThanOrEqual(width);
        }
        for (let index = 0; index < targets.length; index++) {
          for (const other of targets.slice(index + 1)) {
            const target = targets[index];
            expect(
              target.right <= other.x ||
                other.right <= target.x ||
                target.bottom <= other.y ||
                other.bottom <= target.y,
            ).toBe(true);
          }
        }
        if (count === 20)
          expect(new Set(targets.map((target) => target.y)).size).toBeGreaterThan(1);
        const chip = chips.first();
        await chip.focus();
        await chip.press("Shift+F10");
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByText(USER, { exact: true })).toBeVisible();
        if (layout === "bubble" && width === 320 && count === 20) {
          await captureSnapshot(page, "reactions-full-viewer-320");
        }
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(chip).toBeFocused();
        await expect(chip).toHaveAttribute("aria-pressed", "true");

        // Browser-generated right-click release must never toggle the chip.
        await chip.click({ button: "right" });
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await expect(chip).toHaveAttribute("aria-pressed", "true");

        // A simulated touch hold followed by its compatibility click only views.
        // Retain the real gesture origin before Radix hides the background
        // from role queries. Touch release still belongs to that DOM node.
        const gestureOrigin = await chip.elementHandle();
        expect(gestureOrigin).not.toBeNull();
        await chip.dispatchEvent("touchstart", {
          touches: [{ identifier: 1, clientX: 1, clientY: 1 }],
        });
        await expect(dialog).toBeVisible();
        await gestureOrigin!.dispatchEvent("touchend", { touches: [] });
        await gestureOrigin!.dispatchEvent("click");
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await expect(chip).toHaveAttribute("aria-pressed", "true");

        // The separate details action becomes visible and 44px when tabbed to.
        await chip.focus();
        await page.keyboard.press("Tab");
        const details = bar.getByRole("button", {
          name: "View all 1 reactions for 👍",
          exact: true,
        });
        await expect(details).toBeFocused();
        const detailBounds = await details.boundingBox();
        expect(detailBounds!.height).toBeGreaterThanOrEqual(44);
        expect(detailBounds!.width).toBeGreaterThanOrEqual(44);
        await details.press("Enter");
        await expect(dialog).toBeVisible();
        await expect
          .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
          .toBe(true);
        // A reactor tooltip must not compete with the modal for Escape.
        await expect(page.getByRole("tooltip")).toHaveCount(0);
        await page.keyboard.press("Escape");
        try {
          await expect(dialog).toHaveCount(0);
          await expect(details).toBeFocused();
          // Only an ordinary activation removes this user's reaction.
          await chip.click();
          await expect(bar.locator("button[aria-pressed]").filter({ hasText: "👍" })).toHaveCount(
            0,
          );
        } catch (error) {
          console.error(
            "reaction lifecycle diagnostic",
            await page.evaluate(() => ({
              history: (window as unknown as { reactionDiagnostics: unknown }).reactionDiagnostics,
              active: document.activeElement?.outerHTML,
              dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map((node) => ({
                state: node.getAttribute("data-state"),
                text: node.textContent?.slice(0, 100),
              })),
              groups: Array.from(document.querySelectorAll('fieldset[aria-label="Reactions"]')).map(
                (node) => ({
                  hidden: !!node.closest('[aria-hidden="true"]'),
                  html: node.innerHTML,
                }),
              ),
            })),
          );
          throw error;
        }
      });
    }
  }
}
