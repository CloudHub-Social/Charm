import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

/**
 * End-to-end coverage of Spec 02's acceptance flow: attach a file via the
 * picker button, see it render with the correct msgtype in the timeline,
 * open the lightbox for an image, and confirm a non-image file renders as a
 * download chip — against the real app UI with Tauri IPC faked in-browser
 * (see `support/mockTauri.ts`).
 *
 * Scoping note: the drop-zone overlay is exercised here with a real browser
 * DataTransfer. The actual desktop send still uses the attach-button flow below,
 * because browser `File` objects do not expose Tauri's native `.path` extension.
 */

const ROOM = { room_id: "!e2e-media:localhost", name: "Media E2E Room", unread_count: 0 };
const USER_ID = "@e2e:localhost";

test("shows a visible drop target only while files are dragged over the chat", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({
        state: { overrides: { media_send_polish: true } },
        updatedAt: Date.now(),
      }),
    );
  });
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
  });
  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();

  await page.getByTestId("chat-shell").dispatchEvent("dragenter", {
    dataTransfer: await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["hello"], "photo.png", { type: "image/png" }));
      return transfer;
    }),
  });

  await expect(page.getByRole("status")).toContainText(`Drop files in ${ROOM.name}`);

  await page.getByTestId("chat-shell").dispatchEvent("dragleave", {
    dataTransfer: await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["hello"], "photo.png", { type: "image/png" }));
      return transfer;
    }),
  });
  await expect(page.getByRole("status")).toHaveCount(0);
  // snapshot-exempt: this transient overlay is asserted by exact role, copy,
  // and lifecycle; a screenshot would add a synthetic drag-state baseline.
});

test("attaching an image via the picker renders an inline thumbnail and opens in a lightbox", async ({
  page,
}) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
    filePickerResult: "/Users/e2e/photo.png",
  });
  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();
  await expect(page.getByText("No messages yet")).toBeVisible();

  await page.getByRole("button", { name: "Attach" }).click();

  const thumbnail = page.getByRole("button", { name: "Open image photo.png" });
  await expect(thumbnail).toBeVisible();
  await captureSnapshot(page, "media-attachments-image-thumbnail");

  await thumbnail.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("img", { name: "photo.png" })).toBeVisible();
  await captureSnapshot(page, "media-attachments-image-lightbox");

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("attaching a non-image file renders a download chip with filename and size", async ({
  page,
}) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
    filePickerResult: "/Users/e2e/quarterly-report.pdf",
  });
  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();
  await expect(page.getByText("No messages yet")).toBeVisible();

  await page.getByRole("button", { name: "Attach" }).click();

  const chip = page.getByRole("link", { name: "Download quarterly-report.pdf" });
  await expect(chip).toBeVisible();
  await expect(page.getByText("quarterly-report.pdf")).toBeVisible();
  // mockTauri's `send_attachment` gives non-image/video/audio files a fixed
  // 99999-byte size; `humanFileSize` renders that as "98 KB".
  await expect(page.getByText("98 KB")).toBeVisible();
  await captureSnapshot(page, "media-attachments-download-chip");
});

test("upload progress shows while sending and clears once the attachment lands", async ({
  page,
}) => {
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
    filePickerResult: "/Users/e2e/big-video.mp4",
  });
  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();
  await expect(page.getByText("No messages yet")).toBeVisible();

  await page.getByRole("button", { name: "Attach" }).click();

  // mockTauri's `send_attachment` now yields to a macrotask between its
  // partial (50%) and complete (100%) `upload:progress` ticks specifically
  // so this in-flight state is observable — without that, both events fire
  // within one command invocation and React batches add -> remove before
  // ever painting, so a regression that stopped rendering the upload tray
  // entirely would still pass this test.
  await expect(page.getByText("big-video.mp4")).toBeVisible();
  await expect(page.getByRole("button", { name: "Play video big-video.mp4" })).toHaveCount(0);
  await captureSnapshot(page, "media-attachments-upload-in-progress");

  // The video msgtype renders a play-overlaid thumbnail once the attachment
  // lands, and the upload tray's transient entry is gone.
  await expect(page.getByRole("button", { name: "Play video big-video.mp4" })).toBeVisible();
  await expect(page.getByText("big-video.mp4", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Upload failed")).toHaveCount(0);
  await captureSnapshot(page, "media-attachments-upload-complete");
});

/**
 * Spec 42 (media_send_polish): captioning, upload cancel, and size preflight
 * only activate behind the flag — every test below flips it on the same way
 * the drop-target test above does.
 */
function enableMediaSendPolish(page: import("@playwright/test").Page) {
  return page.addInitScript(() => {
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({
        state: { overrides: { media_send_polish: true } },
        updatedAt: Date.now(),
      }),
    );
  });
}

test("captioning a staged attachment sends and renders the caption", async ({ page }) => {
  await enableMediaSendPolish(page);
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
    filePickerResult: "/Users/e2e/photo.png",
  });
  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();
  await expect(page.getByText("No messages yet")).toBeVisible();

  await page.getByRole("button", { name: "Attach" }).click();

  const captionInput = page.getByRole("textbox", { name: "Attachment caption" });
  await expect(captionInput).toBeVisible();
  await captionInput.fill("Sunset over the lake");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByRole("button", { name: "Open image photo.png" })).toBeVisible();
  await expect(page.getByText("Sunset over the lake")).toBeVisible();
  await captureSnapshot(page, "media-attachments-caption");
});

test("cancelling a staged attachment before sending discards it", async ({ page }) => {
  await enableMediaSendPolish(page);
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
    filePickerResult: "/Users/e2e/photo.png",
  });
  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();
  await expect(page.getByText("No messages yet")).toBeVisible();

  await page.getByRole("button", { name: "Attach" }).click();
  await expect(page.getByRole("textbox", { name: "Attachment caption" })).toBeVisible();

  await page.getByRole("button", { name: "Cancel attachment" }).click();

  await expect(page.getByRole("textbox", { name: "Attachment caption" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open image photo.png" })).toHaveCount(0);
});

test("cancelling an in-flight upload removes it from the tray", async ({ page }) => {
  await enableMediaSendPolish(page);
  await page.addInitScript(installMockTauri, {
    userId: USER_ID,
    deviceId: "E2E_DEVICE",
    room: ROOM,
    filePickerResult: "/Users/e2e/big-video.mp4",
  });
  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();
  await expect(page.getByText("No messages yet")).toBeVisible();

  await page.getByRole("button", { name: "Attach" }).click();
  await page.getByRole("button", { name: "Send" }).click();

  const uploadRow = page.getByText("big-video.mp4");
  await expect(uploadRow).toBeVisible();
  await page.getByRole("button", { name: "Cancel upload big-video.mp4" }).click();
  await expect(uploadRow).toHaveCount(0);
});
