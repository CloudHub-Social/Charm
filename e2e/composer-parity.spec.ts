import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

const ROOM = { room_id: "!composer:localhost", name: "Composer Room", unread_count: 0 };
const DIRECT_ROOM = {
  room_id: "!direct:localhost",
  name: "Direct Conversation",
  unread_count: 0,
  is_direct: true,
  dm_peer_user_id: "@alice:localhost",
};

declare global {
  interface Window {
    __e2eComposerActions: Array<{ command: string; args?: Record<string, unknown> }>;
  }
}

for (const enabled of [false, true]) {
  test.describe(`composer parity flag ${enabled ? "on" : "off"}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((flag) => {
        localStorage.setItem(
          "charm:featureFlags",
          JSON.stringify({
            // Narrow-width cases exercise the mobile shell's formatting toggle;
            // composer parity still varies independently in both states.
            state: { overrides: { composer_parity: flag, mobile_chat_redesign: true } },
            updatedAt: Date.now(),
          }),
        );
      }, enabled);
      await page.addInitScript(installMockTauri, {
        userId: "@composer:localhost",
        deviceId: "COMPOSER_DEVICE",
        room: ROOM,
        extraRooms: [DIRECT_ROOM],
      });
      await page.addInitScript(() => {
        window.__e2eComposerActions = [];
        const originalInvoke = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = (command, args) => {
          if (command === "set_room_profile" || command === "start_direct_message") {
            window.__e2eComposerActions.push({ command, args });
          }
          if (command === "get_user_profile") {
            return originalInvoke(command, args).then((profile) => ({
              ...(profile as Record<string, unknown>),
              room_avatar_url: "mxc://localhost/room-avatar",
            }));
          }
          return originalInvoke(command, args);
        };
      });
      await page.goto("/");
      await page.getByRole("button", { name: ROOM.name }).click();
      await expect(page.getByText("No messages yet")).toBeVisible();
    });

    test("gates new controls and empty-composer editing without changing drafts", async ({
      page,
    }) => {
      const composer = page.getByPlaceholder(`Message ${ROOM.name}`);
      for (const name of ["Spoiler", "Strikethrough", "Code block"]) {
        await expect(page.getByRole("button", { name, exact: true })).toHaveCount(enabled ? 1 : 0);
      }
      await expect(composer).toHaveAttribute("spellcheck", String(enabled));
      await captureSnapshot(page, `composer-parity-controls-${enabled ? "on" : "off"}`);
      await composer.fill("original composer message");
      await composer.press("Enter");
      await expect(page.getByText("original composer message", { exact: true })).toBeVisible();
      await expect(page.getByText(/sending…/)).toHaveCount(0);

      await composer.fill("keep this draft");
      await composer.press("ArrowUp");
      await expect(composer).toHaveText("keep this draft");
      await expect(page.getByText("Editing message", { exact: true })).toHaveCount(0);

      await composer.press("Control+A");
      await composer.press("Backspace");
      await expect(composer).toHaveText("");
      await composer.press("ArrowUp");
      if (enabled) {
        await expect(page.getByText("Editing message", { exact: true })).toBeVisible();
        await expect(composer).toHaveText("original composer message");
        await captureSnapshot(page, "composer-parity-keyboard-edit");
        await composer.fill("updated via keyboard");
        await composer.press("Enter");
        await expect(page.getByText("updated via keyboard", { exact: true })).toBeVisible();
        // Bubble layout shares the edited suffix with its timestamp; it is
        // not a standalone text node (see BubbleMessageRow).
        await expect(page.getByText(/\(edited\)$/)).toBeVisible();
        await expect(page.getByText("original composer message", { exact: true })).toHaveCount(0);
        await expect(page.getByText("Editing message", { exact: true })).toHaveCount(0);
      } else {
        await expect(page.getByText("Editing message", { exact: true })).toHaveCount(0);
        await expect(composer).toHaveText("");
      }
    });

    test("gates the plain-message slash command", async ({ page }) => {
      const composer = page.getByPlaceholder(`Message ${ROOM.name}`);
      await composer.fill("/plain <b>literal markup</b>");
      await composer.press("Enter");
      if (enabled) {
        await expect(page.getByText("<b>literal markup</b>", { exact: true })).toBeVisible();
        await expect(composer).toHaveText("");
      } else {
        await expect(composer).toHaveText("/plain <b>literal markup</b>");
        await expect(
          page.getByText(
            "/plain is unavailable while composer parity is disabled. Your draft was not sent.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(
          page.locator('[id^="message-"]').filter({ hasText: "/plain <b>literal markup</b>" }),
        ).toHaveCount(0);
      }
      await expect(page.getByText(/sending…/)).toHaveCount(0);
    });

    test("gates room nicknames and opens direct messages without posting command text", async ({
      page,
    }) => {
      const composer = page.getByPlaceholder(`Message ${ROOM.name}`);
      await composer.fill("/myroomnick Room Display Name");
      await composer.press("Enter");
      if (enabled) {
        await expect
          .poll(() => page.evaluate(() => window.__e2eComposerActions))
          .toEqual([
            {
              command: "set_room_profile",
              args: {
                roomId: ROOM.room_id,
                displayName: "Room Display Name",
                avatarUrl: "mxc://localhost/room-avatar",
              },
            },
          ]);
        await expect(composer).toHaveText("");
      } else {
        await expect(composer).toHaveText("/myroomnick Room Display Name");
        await expect(page.getByText(/\/myroomnick is unavailable/)).toBeVisible();
      }
      await expect(page.locator('[id^="message-"]')).toHaveCount(0);

      await composer.fill("/startdm @alice:localhost");
      await composer.press("Enter");
      if (enabled) {
        await expect(page.getByPlaceholder(`Message ${DIRECT_ROOM.name}`)).toBeVisible();
        await expect
          .poll(() => page.evaluate(() => window.__e2eComposerActions.at(-1)))
          .toEqual({
            command: "start_direct_message",
            args: { userId: "@alice:localhost" },
          });
      } else {
        await expect(composer).toHaveText("/startdm @alice:localhost");
        await expect(page.getByText(/\/startdm is unavailable/)).toBeVisible();
        expect(await page.evaluate(() => window.__e2eComposerActions)).toEqual([]);
      }
      await expect(page.locator('[id^="message-"]')).toHaveCount(0);
    });

    for (const width of [320, 375]) {
      test(`keeps formatting controls inside the composer at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 740 });
        await page.getByRole("button", { name: "Show formatting", exact: true }).click();
        const toolbar = page.getByRole("toolbar", { name: "Formatting" });
        await expect(toolbar).toBeVisible();
        await expect
          .poll(async () =>
            toolbar.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              return (
                bounds.left >= 0 &&
                bounds.right <= window.innerWidth &&
                [...element.querySelectorAll("button")].every((button) => {
                  const rect = button.getBoundingClientRect();
                  return (
                    rect.left >= bounds.left &&
                    rect.right <= bounds.right + 1 &&
                    rect.top >= bounds.top &&
                    rect.bottom <= bounds.bottom + 1
                  );
                })
              );
            }),
          )
          .toBe(true);
      });
    }
  });
}
