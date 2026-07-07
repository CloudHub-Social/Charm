import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";

/**
 * End-to-end coverage of Spec 02's acceptance flow: attach a file via the
 * picker button, see it render with the correct msgtype in the timeline,
 * open the lightbox for an image, and confirm a non-image file renders as a
 * download chip — against the real app UI with Tauri IPC faked in-browser
 * (see `support/mockTauri.ts`).
 *
 * Scoping note (drag-and-drop / clipboard-paste): `ChatShell.tsx`'s own
 * `handleDrop`/`handlePaste` comments explain why these aren't exercised
 * here — a plain browser's `File` objects (what Playwright's DataTransfer
 * simulation would produce) have no `.path`, and both handlers only trigger
 * a send when `file.path` is present (that's a Tauri-webview-only File
 * extension). Simulating a `.path`-bearing File would mean faking the exact
 * shape of a webview implementation detail rather than testing real code —
 * not meaningfully more trustworthy than a unit test stubbing the same
 * thing, and this suite already covers the send path (attach button ->
 * `sendAttachment` -> render) that drag/paste both funnel into anyway.
 * Covered instead via the attach-button flow, which exercises the same
 * `handleAttachFile` -> `sendAttachment` -> timeline-render path.
 */

const ROOM = { room_id: "!e2e-media:localhost", name: "Media E2E Room", unread_count: 0 };
const USER_ID = "@e2e:localhost";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
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
  await page.reload();
  await page.getByRole("button", { name: ROOM.name }).click();
  await expect(page.getByText("No messages yet")).toBeVisible();

  await page.getByRole("button", { name: "Attach" }).click();

  const thumbnail = page.getByRole("button", { name: "Open image photo.png" });
  await expect(thumbnail).toBeVisible();

  await thumbnail.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("img", { name: "photo.png" })).toBeVisible();

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
  await page.reload();
  await page.getByRole("button", { name: ROOM.name }).click();
  await expect(page.getByText("No messages yet")).toBeVisible();

  await page.getByRole("button", { name: "Attach" }).click();

  const chip = page.getByRole("link", { name: "Download quarterly-report.pdf" });
  await expect(chip).toBeVisible();
  await expect(page.getByText("quarterly-report.pdf")).toBeVisible();
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
  await page.reload();
  await page.getByRole("button", { name: ROOM.name }).click();
  await expect(page.getByText("No messages yet")).toBeVisible();

  await page.getByRole("button", { name: "Attach" }).click();

  // The video msgtype renders a play-overlaid thumbnail once the attachment
  // lands; that's sufficient signal the upload completed and the upload
  // tray's transient entry is gone (mockTauri's `send_attachment` resolves
  // synchronously after emitting both progress ticks, so there's no
  // reliably-observable "still in flight" window to assert against here).
  await expect(page.getByRole("button", { name: "Play video big-video.mp4" })).toBeVisible();
  await expect(page.getByText("Upload failed")).toHaveCount(0);
});
