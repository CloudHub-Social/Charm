import { expect, type Page, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

/**
 * Spec 26 Phase 2 — bottom-up, virtualized timeline rendering. Unit tests
 * (`ChatShell.test.tsx`) fake `react-virtuoso` itself (jsdom never computes
 * real layout, so the library's actual bottom-anchor/virtualization math
 * can't be meaningfully exercised there — see that file's comment). This
 * suite runs the real `Virtuoso` component against a real browser layout,
 * which is what Phase 1's PR explicitly skipped for scroll behavior.
 */

const ROOM = { room_id: "!e2e-scroll:localhost", name: "Scroll Room", unread_count: 0 };
const USER_ID = "@e2e:localhost";
const OTHER_USER = "@other:localhost";

function makeMessage(i: number, overrides: Record<string, unknown> = {}) {
  return {
    event_id: `$msg-${i}`,
    sender: OTHER_USER,
    sender_display_name: "Other User",
    sender_avatar_url: null,
    sender_avatar_path: null,
    body: `message number ${i}`,
    formatted_body: null,
    timestamp_ms: i + 1,
    edited: false,
    redacted: false,
    reactions: [],
    in_reply_to: null,
    transaction_id: null,
    send_state: { state: "sent" },
    media: null,
    is_undecrypted: false,
    ...overrides,
  };
}

async function seedMessages(page: Page, count: number) {
  await page.evaluate(
    ({ roomId, messages }) => {
      window.__e2eEmit("timeline:update", { room_id: roomId, messages });
    },
    { roomId: ROOM.room_id, messages: Array.from({ length: count }, (_, i) => makeMessage(i)) },
  );
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
  });
  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();
  await expect(page.getByText("No messages yet")).toBeVisible();
});

test("opens scrolled to the newest message, with older history not yet in view", async ({
  page,
}) => {
  await seedMessages(page, 60);

  await expect(page.getByText("message number 59")).toBeVisible();
  // The scroller opens bottom-anchored — its very first (oldest-loaded)
  // message isn't scrolled into view without the user scrolling up to it.
  await expect(page.getByText("message number 0")).not.toBeInViewport();
});

test("stays pinned to bottom when a live message arrives while already at bottom", async ({
  page,
}) => {
  await seedMessages(page, 20);
  await expect(page.getByText("message number 19")).toBeVisible();

  await seedMessages(page, 21);

  await expect(page.getByText("message number 20")).toBeInViewport();
});

test("does not yank the view when scrolled away from bottom, and shows a jump-to-present pill instead", async ({
  page,
}) => {
  await seedMessages(page, 60);
  await expect(page.getByText("message number 59")).toBeVisible();

  const scroller = page.locator('[data-virtuoso-scroller="true"]');
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.getByText("message number 0")).toBeInViewport();

  await seedMessages(page, 61);

  // Charm 1.0 issue #328 ("Jump to Present is overly sticky") regression
  // guard: the newly-arrived message must NOT force the view back down.
  await expect(page.getByText("message number 0")).toBeInViewport();
  await expect(page.getByText("message number 60")).not.toBeInViewport();

  const pill = page.getByRole("button", { name: "1 new message" });
  await expect(pill).toBeVisible();
  await captureSnapshot(page, "timeline-scroll-jump-to-present-pill");

  await pill.click();

  await expect(page.getByText("message number 60")).toBeInViewport();
  await expect(page.getByRole("button", { name: /new message/ })).toHaveCount(0);
});

test("does not show the jump-to-present pill while already at bottom", async ({ page }) => {
  await seedMessages(page, 5);
  await expect(page.getByText("message number 4")).toBeVisible();

  await seedMessages(page, 6);

  await expect(page.getByText("message number 5")).toBeVisible();
  await expect(page.getByRole("button", { name: /new message/ })).toHaveCount(0);
});
