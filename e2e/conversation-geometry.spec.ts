import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

test.use({ hasTouch: true });

const ROOM = { room_id: "!geometry:localhost", name: "Geometry room", unread_count: 0 };

for (const layout of ["bubble", "discord", "irc"] as const) {
  for (const width of [320, 375, 390, 430]) {
    for (const content of ["plain", "rich", "reply", "failed", "media"] as const) {
      test(`${layout} contains ${content} conversation content at ${width}px`, async ({ page }) => {
        await page.clock.setFixedTime(new Date("2026-09-07T12:00:00Z"));
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((messageLayout) => {
          localStorage.setItem(
            "charm:featureFlags",
            JSON.stringify({
              state: {
                overrides: {
                  ux_refresh_v1: true,
                  message_action_parity: true,
                  rich_message_rendering: true,
                },
              },
              updatedAt: Date.now(),
            }),
          );
          localStorage.setItem(
            "charm:appearance",
            JSON.stringify({ state: { messageLayout }, updatedAt: Date.now() }),
          );
        }, layout);
        await page.addInitScript(installMockTauri, {
          userId: "@geometry:localhost",
          deviceId: "GEOMETRY_TEST",
          room: ROOM,
          initialMessages: [
            {
              event_id: content === "failed" ? "txn-geometry" : "$geometry",
              sender: content === "failed" ? "@geometry:localhost" : "@other:localhost",
              sender_display_name: "A deliberately long bridged participant name (Discord)",
              sender_avatar_url: null,
              sender_avatar_path: null,
              body: `A message with a long identifier: ${"x".repeat(200)}`,
              formatted_body:
                content === "rich"
                  ? `<p>https://example.org/${"path".repeat(60)}</p><pre><code>${"wide_code_".repeat(50)}</code></pre><table><tr><td>${"wide_cell_".repeat(50)}</td></tr></table><div data-mx-maths="${"x+".repeat(80)}x"></div>`
                  : null,
              timestamp_ms: 1788724800000,
              edited: false,
              redacted: false,
              reactions: ["💜", "👍", "🎉", "👀", "✨"].map((key) => ({
                key,
                count: 2,
                reacted_by_me: false,
              })),
              in_reply_to:
                content === "reply"
                  ? {
                      event_id: "$original",
                      sender: "@original:localhost",
                      sender_display_name: "Long bridged reply author ".repeat(8),
                      preview: "unbroken_reply_".repeat(40),
                    }
                  : null,
              transaction_id: content === "failed" ? "txn-geometry" : null,
              send_state:
                content === "failed"
                  ? { state: "error", message: "Synthetic send failure" }
                  : { state: "sent" },
              media:
                content === "media"
                  ? {
                      type: "File",
                      filename: "long_attachment_".repeat(20) + ".pdf",
                      mime: "application/pdf",
                      size: 100000,
                      caption: null,
                    }
                  : null,
              poll: null,
              is_undecrypted: false,
              text_editable: true,
            },
          ],
        });
        await page.goto("/");
        const row = page.locator(
          content === "failed" ? '[id="message-txn-geometry"]' : '[id="message-$geometry"]',
        );
        await expect(row).toBeVisible();

        // Row dimensions catch clipping that could fool a document-only check.
        await expect
          .poll(async () => {
            return row.evaluate((element) => {
              const viewportWidth = document.documentElement.clientWidth;
              const bounds = element.getBoundingClientRect();
              return {
                rowOverflow: Math.max(0, element.scrollWidth - element.clientWidth),
                rightOverflow: Math.max(0, bounds.right - viewportWidth),
                leftOverflow: Math.max(0, -bounds.left),
                documentOverflow: Math.max(0, document.documentElement.scrollWidth - viewportWidth),
              };
            });
          })
          .toEqual({ rowOverflow: 0, rightOverflow: 0, leftOverflow: 0, documentOverflow: 0 });

        // Verify the complete ancestor chain, including the item wrapper, timeline,
        // pane and shell; clipping at any of these must not conceal wider rows.
        await expect
          .poll(() =>
            row.evaluate((element) => {
              const violations: string[] = [];
              for (let node: Element | null = element; node; node = node.parentElement) {
                if (node.scrollWidth > node.clientWidth)
                  violations.push(node.tagName + ":" + node.className);
              }
              return violations;
            }),
          )
          .toEqual([]);

        if (content === "rich") {
          // Only explicit code/table/math wrappers may own horizontal overflow.
          // Prove overflowing content remains reachable by scrolling that owner.
          for (const selector of [
            ".group\\/code",
            "div:has(> table)",
            "div:has(> .katex-display)",
          ]) {
            const owner = row.locator(selector);
            await expect(owner).toHaveCount(1);
            await expect
              .poll(() =>
                owner.evaluate((element) => {
                  const style = getComputedStyle(element);
                  const overflowing = element.scrollWidth > element.clientWidth;
                  element.scrollLeft = element.scrollWidth;
                  return {
                    owned: ["auto", "scroll"].includes(style.overflowX),
                    reachable: !overflowing || element.scrollLeft > 0,
                  };
                }),
              )
              .toEqual({ owned: true, reachable: true });
          }
        }
        await captureSnapshot(
          page,
          content === "plain"
            ? `conversation-geometry-${layout}-${width}`
            : `conversation-geometry-${layout}-${width}-${content}`,
        );

        const more = row.getByRole("button", { name: "More actions" });
        if (content === "plain") await row.tap();
        else await more.focus();
        await expect(row.locator("[data-message-actions]")).toHaveCSS("opacity", "1");
        await more.click();
        await expect(page.getByRole("menu")).toBeVisible();
        if (content === "failed") {
          await expect(page.getByRole("menuitem", { name: "Reply", exact: true })).toBeDisabled();
          await expect(page.getByRole("menuitem", { name: "Resend", exact: true })).toBeVisible();
        } else {
          await expect(page.getByRole("menuitem", { name: "Reply", exact: true })).toBeVisible();
        }
      });
    }
  }
}
