import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

const ROOM = { room_id: "!feature-gallery:e2e", name: "Charm Contributors", unread_count: 0 };
const USER_ID = "@charm-docs:cloudhub.social";
const MATRIX_SPEC_URL = "https://spec.matrix.org/latest/client-server-api/";

function enableFlags(flags: Record<string, boolean>) {
  localStorage.setItem(
    "charm:featureFlags",
    JSON.stringify({ state: { overrides: flags }, updatedAt: Date.now() }),
  );
}

test("forget local data requires explicit confirmation and can be cancelled", async ({ page }) => {
  await page.addInitScript(enableFlags, { forget_local_data: true });
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "FEATURE_DOCS",
    room: ROOM,
  });
  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("button", { name: "Forget local data", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Forget local data?", exact: true });
  await expect(confirmation).toBeVisible();
  const forget = confirmation.getByRole("button", { name: "Forget local data", exact: true });
  await expect(forget).toBeDisabled();
  await expect(
    confirmation.getByText(/Matrix account and server-side messages are not deleted/),
  ).toBeVisible();
  await captureSnapshot(page, "feature-forget-local-data-confirm");
  await confirmation.getByLabel("Type FORGET to confirm").fill("FORGET");
  await expect(forget).toBeEnabled();
  // The gallery demonstrates the consent boundary, not native deletion against a mock host.
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
});

test("full emoji picker opens from the composer", async ({ page }) => {
  await page.addInitScript(enableFlags, { full_emoji_picker: true });
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "FEATURE_DOCS",
    room: ROOM,
  });

  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();
  await page.getByRole("button", { name: "Insert emoji" }).click();
  await expect(page.getByPlaceholder("Search emoji")).toBeVisible();
  await captureSnapshot(page, "feature-full-emoji-picker");
});

test("link previews render inside a complete conversation", async ({ page }) => {
  await page.addInitScript(enableFlags, { link_previews: true });
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "FEATURE_DOCS",
    room: ROOM,
    initialMessages: [
      {
        event_id: "$feature-link-preview",
        sender: "@alice:cloudhub.social",
        sender_display_name: "Alice",
        sender_avatar_url: null,
        sender_avatar_path: null,
        body: `The Matrix client-server API is documented at ${MATRIX_SPEC_URL}`,
        formatted_body: null,
        timestamp_ms: 1735689600000,
        edited: false,
        redacted: false,
        reactions: [],
        in_reply_to: null,
        transaction_id: null,
        send_state: { state: "sent" },
      },
    ],
    urlPreviews: {
      [MATRIX_SPEC_URL]: {
        title: "Matrix Client-Server API",
        description: "The protocol used by Matrix clients to communicate with homeservers.",
        imageUrl: null,
        imageWidth: null,
        imageHeight: null,
        siteName: "Matrix Specification",
      },
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();
  await expect(page.getByText("Matrix Client-Server API", { exact: true })).toBeVisible();
  await captureSnapshot(page, "feature-link-previews");
});

test("timeline membership changes collapse into expandable notices", async ({ page }) => {
  await page.addInitScript(enableFlags, { timeline_state_events: true });
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "FEATURE_DOCS",
    room: ROOM,
  });
  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();
  await expect(page.getByText("No messages yet")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__e2eListenerCount("timeline:update")))
    .toBeGreaterThan(0);

  const message = {
    event_id: "$after-joins",
    sender: "@alice:cloudhub.social",
    sender_display_name: "Alice",
    sender_avatar_url: null,
    sender_avatar_path: null,
    body: "Welcome to the room!",
    formatted_body: null,
    timestamp_ms: 1735689601000,
    edited: false,
    redacted: false,
    reactions: [],
    in_reply_to: null,
    transaction_id: null,
    send_state: { state: "sent" },
    media: null,
    is_undecrypted: false,
  };
  const emitTimeline = () =>
    page.evaluate(
      ({ roomId, message: timelineMessage }) => {
        const memberships = [
          ["Alice", "@alice:cloudhub.social"],
          ["Bob", "@bob:cloudhub.social"],
          ["Carol", "@carol:cloudhub.social"],
        ].map(([name, userId], index) => ({
          kind: "membership",
          event_id: `$join-${index + 1}`,
          sender: userId,
          timestamp_ms: 1735689600001 + index,
          target_user_id: userId,
          target_display_name: name,
          change: { type: "joined" },
          reason: null,
        }));
        window.__e2eEmit("timeline:update", {
          room_id: roomId,
          messages: [timelineMessage],
          items: [
            ...memberships,
            {
              kind: "state",
              event_id: "$topic",
              sender: "@alice:cloudhub.social",
              timestamp_ms: 1735689600004,
              state_key: "",
              change: { type: "topic", old_value: null, new_value: "Daily-driver parity" },
            },
            { kind: "message", message: timelineMessage },
          ],
        });
      },
      { roomId: ROOM.room_id, message },
    );

  const collapsedMemberships = page.getByRole("button", {
    name: "Alice (@alice:cloudhub.social), Bob (@bob:cloudhub.social) and 1 other joined",
  });
  // The room-open page request and listener subscription settle
  // independently. Re-emitting the full snapshot is idempotent and avoids
  // racing a late initial page response that would otherwise replace it.
  await expect
    .poll(async () => {
      await emitTimeline();
      return collapsedMemberships.count();
    })
    .toBe(1);
  await expect(collapsedMemberships).toBeVisible();
  await expect(
    page.getByText("@alice:cloudhub.social changed the topic to Daily-driver parity"),
  ).toBeVisible();
  await captureSnapshot(page, "feature-timeline-state-events");
});

test("upgraded rooms direct members to the replacement", async ({ page }) => {
  await page.addInitScript(enableFlags, { room_upgrades: true });
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "FEATURE_DOCS",
    room: ROOM,
  });

  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();
  await expect(page.getByText("No messages yet")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__e2eListenerCount("timeline:update")))
    .toBeGreaterThan(0);

  await page.evaluate((roomId) => {
    window.__e2eEmit("timeline:update", {
      room_id: roomId,
      messages: [],
      items: [
        {
          kind: "state",
          event_id: "$room-upgrade",
          sender: "@admin:cloudhub.social",
          timestamp_ms: 1735689600000,
          state_key: "",
          change: {
            type: "tombstone",
            body: "Continue in the upgraded room",
            replacement_room_id: "!upgraded-room:e2e",
          },
        },
      ],
    });
  }, ROOM.room_id);

  await expect(page.getByText("This room has been upgraded")).toBeVisible();
  await expect(page.getByTestId("composer-shell")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Go to upgraded room" })).toBeVisible();
  await captureSnapshot(page, "feature-room-upgrades");
});

test("room aliases render in the full room settings flow", async ({ page }) => {
  await page.addInitScript(enableFlags, { room_alias_management: true });
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "FEATURE_DOCS",
    room: ROOM,
    roomAliases: ["#charm:cloudhub.social", "#charm-dev:cloudhub.social"],
    roomDetails: {
      canonical_alias: "#charm:cloudhub.social",
      alt_aliases: ["#charm-dev:cloudhub.social"],
    },
  });

  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();
  await page.getByRole("button", { name: "Room settings" }).click();
  const publishedAddresses = page.getByText("Published addresses");
  await expect(publishedAddresses).toBeVisible();
  await expect(page.getByText("#charm-dev:cloudhub.social", { exact: true }).first()).toBeVisible();
  await publishedAddresses.scrollIntoViewIfNeeded();
  await captureSnapshot(page, "feature-room-aliases");
});

test("focus mode renders as an active native setting", async ({ page }) => {
  await page.addInitScript(enableFlags, { focus_mode: true });
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "FEATURE_DOCS",
    room: ROOM,
    dndState: { enabled: true, until: null, revision: 1 },
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("tab", { name: "Focus" }).click();
  await expect(page.getByLabel("Do Not Disturb is active")).toBeVisible();
  await captureSnapshot(page, "feature-focus-mode");
});

test("saved messages lists a bookmark with room and sender context", async ({ page }) => {
  await page.addInitScript(enableFlags, { bookmarks: true });
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "FEATURE_DOCS",
    room: ROOM,
    initialMessages: [
      {
        event_id: "$feature-bookmark",
        sender: "@alice:cloudhub.social",
        sender_display_name: "Alice",
        sender_avatar_url: null,
        sender_avatar_path: null,
        body: "Let's ship the bookmarks feature this week.",
        formatted_body: null,
        timestamp_ms: 1735689600000,
        edited: false,
        redacted: false,
        reactions: [],
        in_reply_to: null,
        transaction_id: null,
        send_state: { state: "sent" },
      },
    ],
    bookmarks: [
      {
        room_id: ROOM.room_id,
        event_id: "$feature-bookmark",
        saved_at_ms: 1735689600000,
        sender: "@alice:cloudhub.social",
        sender_display_name: "Alice",
        body_preview: "Let's ship the bookmarks feature this week.",
        timestamp_ms: 1735689600000,
      },
    ],
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("tab", { name: "Saved Messages" }).click();
  await expect(page.getByText("Let's ship the bookmarks feature this week.")).toBeVisible();
  await expect(page.getByText("Alice", { exact: true })).toBeVisible();
  await captureSnapshot(page, "feature-bookmarks-saved-messages");
});
