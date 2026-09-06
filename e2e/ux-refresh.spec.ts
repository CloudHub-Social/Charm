import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

test("UX refresh rail prioritizes unread people without double-counting overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({
        state: { overrides: { ux_refresh_v1: true } },
        updatedAt: Date.now(),
      }),
    );
    localStorage.setItem(
      "charm:appearance",
      JSON.stringify({
        state: { messageLayout: "discord", theme: "dark" },
        updatedAt: Date.now(),
      }),
    );
  });
  await page.addInitScript(installMockTauri, {
    userId: "@evie:cloudhub.social",
    deviceId: "UX_REFRESH",
    room: { room_id: "!general:e2e", name: "Charm Lounge", unread_count: 0 },
    extraRooms: [
      {
        room_id: "!alice:e2e",
        name: "Alice",
        is_direct: true,
        has_unread: true,
        unread_count: 2,
        last_activity_ts: 500,
      },
      {
        room_id: "!beatrice:e2e",
        name: "Beatrice",
        is_direct: true,
        has_unread: true,
        last_activity_ts: 400,
      },
      {
        room_id: "!cam:e2e",
        name: "Cam",
        is_direct: true,
        has_unread: true,
        unread_count: 1,
        last_activity_ts: 300,
      },
      {
        room_id: "!devon:e2e",
        name: "Devon",
        is_direct: true,
        has_unread: true,
        unread_count: 4,
        last_activity_ts: 200,
      },
      {
        room_id: "!emery:e2e",
        name: "Emery",
        is_direct: true,
        has_unread: true,
        last_activity_ts: 100,
      },
      { room_id: "!space:e2e", name: "CloudHub", is_space: true },
    ],
    initialMessages: [
      {
        event_id: "$welcome",
        sender: "@ada:cloudhub.social",
        sender_display_name: "Ada",
        sender_avatar_url: null,
        sender_avatar_path: null,
        body: "Welcome back — the navigation and conversation shell are ready for review.",
        formatted_body: null,
        timestamp_ms: 1788724800000,
        edited: false,
        redacted: false,
        reactions: [{ key: "💜", count: 3, reacted_by_me: true }],
        in_reply_to: null,
        transaction_id: null,
        send_state: { state: "sent" },
        media: null,
        poll: null,
        is_undecrypted: false,
        text_editable: true,
      },
      {
        event_id: "$follow-up",
        sender: "@ada:cloudhub.social",
        sender_display_name: "Ada",
        sender_avatar_url: null,
        sender_avatar_path: null,
        body: "Everything stays warm, focused, and distinctly Charm.",
        formatted_body: null,
        timestamp_ms: 1788724860000,
        edited: false,
        redacted: false,
        reactions: [],
        in_reply_to: null,
        transaction_id: null,
        send_state: { state: "sent" },
        media: null,
        poll: null,
        is_undecrypted: false,
        text_editable: true,
      },
    ],
  });

  await page.goto("/");

  const rail = page.locator('aside[data-ux-refresh="true"]');
  await expect(rail).toBeVisible();
  await expect(rail.getByRole("button", { name: "Alice, 1 unread, 2 mentions" })).toBeVisible();
  await expect(rail.getByRole("button", { name: "Beatrice, 1 unread" })).toBeVisible();
  await expect(rail.getByRole("button", { name: "Cam, 1 unread, 1 mentions" })).toBeVisible();
  await expect(
    rail.getByRole("button", { name: "Direct messages, 2 unread, 4 mentions" }),
  ).toBeVisible();
  await expect(rail.getByRole("button", { name: /^Devon,/ })).toHaveCount(0);
  await expect(rail.getByRole("button", { name: /^Emery,/ })).toHaveCount(0);

  await rail.getByRole("button", { name: "Alice, 1 unread, 2 mentions" }).click();
  await expect(rail.getByRole("button", { name: /^Alice(?:,|$)/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    rail.getByRole("button", { name: "Direct messages, 2 unread, 4 mentions" }),
  ).not.toHaveAttribute("aria-current");

  await rail.getByRole("button", { name: /^Home/ }).click();
  await page.getByRole("button", { name: /Charm Lounge/i }).click();
  await expect(
    page.getByText("Everything stays warm, focused, and distinctly Charm."),
  ).toBeVisible();
  await captureSnapshot(page, "ux-refresh-navigation-rail");
  await captureSnapshot(page, "ux-refresh-desktop-1440x900");

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole("button", { name: "Show members" }).click();
  await expect(page.getByRole("heading", { name: "Members" })).toBeVisible();
  await captureSnapshot(page, "ux-refresh-medium-1024x768");
  await page.getByRole("button", { name: "Close members" }).click();

  await page.setViewportSize({ width: 768, height: 1024 });
  await captureSnapshot(page, "ux-refresh-tablet-768x1024");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Back to chats")).toBeVisible();
  await captureSnapshot(page, "ux-refresh-mobile-conversation-390x844");

  await page.getByLabel("Back to chats").click();
  await page
    .getByRole("button", { name: /^Activity/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await captureSnapshot(page, "ux-refresh-mobile-activity-390x844");
});
