import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";

const ROOM = { room_id: "!voice:localhost", name: "Voice Room", unread_count: 0 };

// Only this suite launches with Chromium's synthetic audio source. No physical
// microphone or real homeserver is used; MediaRecorder itself remains real.
test.use({
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
});

for (const enabled of [false, true]) {
  test(`voice recording is ${enabled ? "available with local preview" : "hidden by default"}`, async ({
    page,
  }) => {
    await page.addInitScript((flag) => {
      localStorage.setItem(
        "charm:featureFlags",
        JSON.stringify({
          state: { overrides: { voice_recording: flag } },
          updatedAt: Date.now(),
        }),
      );
    }, enabled);
    await page.addInitScript(installMockTauri, {
      userId: "@voice:localhost",
      deviceId: "VOICE_DEVICE",
      room: ROOM,
    });
    await page.goto("/");
    await page.getByRole("button", { name: ROOM.name }).click();
    const start = page.getByRole("button", { name: "Record voice message", exact: true });
    if (!enabled) {
      await expect(start).toHaveCount(0);
      await captureSnapshot(page, "voice-recording-disabled");
      return;
    }
    await start.click();
    await expect(page.getByLabel("Microphone level")).toBeVisible();
    await expect(page.getByLabel("Recording duration")).not.toHaveText("0:00");
    await page.getByRole("button", { name: "Stop recording", exact: true }).click();
    const preview = page.getByLabel("Voice message preview");
    await expect(preview).toHaveAttribute("src", /^blob:/);
    await expect(
      page.getByRole("button", { name: "Send voice message", exact: true }),
    ).toBeVisible();
    // Stopping is not sending: the timeline remains empty until explicit Send.
    await expect(page.getByText("No messages yet", { exact: true })).toBeVisible();
    await captureSnapshot(page, "voice-recording-local-preview");
    await page.getByRole("button", { name: "Discard recording", exact: true }).click();
    await expect(preview).toHaveCount(0);
    await expect(start).toBeVisible();
    await expect(page.getByText("No messages yet", { exact: true })).toBeVisible();
  });
}
