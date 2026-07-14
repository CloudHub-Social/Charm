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
