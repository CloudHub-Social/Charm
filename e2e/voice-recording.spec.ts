import { expect, test } from "@playwright/test";
import { installMockTauri } from "./support/mockTauri";
import { captureSnapshot } from "./support/sentrySnapshot";
import nativeConfig from "../src-tauri/tauri.conf.json" with { type: "json" };

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
    // Vite does not serve the native CSP. Apply its media restriction before
    // recording so a blob URL alone cannot masquerade as a playable preview.
    await page.evaluate((sources) => {
      const policy = document.createElement("meta");
      policy.httpEquiv = "Content-Security-Policy";
      policy.content = `media-src ${sources}`;
      document.head.append(policy);
    }, nativeConfig.app.security.csp["media-src"]);
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
    await expect
      .poll(() => preview.evaluate((audio: HTMLAudioElement) => audio.readyState))
      .toBeGreaterThan(0);
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

test("one integrated composer retains its draft through voice preview, retry and adaptive resize", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({
        state: { overrides: { voice_recording: true, ux_refresh_v1: true, composer_parity: true } },
        updatedAt: Date.now(),
      }),
    );
  });
  await page.addInitScript(installMockTauri, {
    userId: "@voice:localhost",
    deviceId: "VOICE_DEVICE",
    room: ROOM,
  });
  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();
  await page.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    const evidence = {
      voice: [] as Array<{ room: unknown; metadata: unknown; bytes: unknown }>,
      text: 0,
    };
    (window as unknown as { __integratedVoice: typeof evidence }).__integratedVoice = evidence;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "send_message") evidence.text += 1;
      if (command === "send_attachment" && args?.voice) {
        evidence.voice.push({ room: args.roomId, metadata: args.voice, bytes: args.recording });
        if (evidence.voice.length === 1) throw new Error("Synthetic voice retry");
      }
      return original(command, args);
    };
  });
  const shell = page.getByTestId("composer-shell");
  const editor = shell.locator('[contenteditable="true"]');
  await editor.fill("Private text remains while voice owns send");
  await editor.evaluate((element) => element.setAttribute("data-composer-owner", "retained"));
  const start = shell.getByRole("button", { name: "Record voice message", exact: true });
  await expect(shell.locator('section[aria-label="Voice message"]')).toHaveCount(1);
  await start.click();
  await expect(page.getByLabel("Recording duration")).not.toHaveText("0:00");
  await editor.press("Enter");
  await expect(editor).toContainText("Private text remains while voice owns send");
  await expect(shell.getByRole("button", { name: "Attach", exact: true })).toBeDisabled();
  await shell.getByRole("button", { name: "Stop recording", exact: true }).click();
  const preview = shell.getByLabel("Voice message preview");
  await expect(preview).toHaveAttribute("src", /^blob:/);
  await preview.evaluate((element) => element.setAttribute("data-voice-owner", "retained"));
  for (const width of [1199, 834, 768, 767, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(editor).toHaveAttribute("data-composer-owner", "retained");
    await expect(preview).toHaveAttribute("data-voice-owner", "retained");
    await expect(editor).toContainText("Private text remains while voice owns send");
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
    const bounds = await preview.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  }
  await shell.getByRole("button", { name: "Send voice message", exact: true }).click();
  await expect(
    shell.getByRole("button", { name: "Retry voice message", exact: true }),
  ).toBeVisible();
  await expect(editor).toContainText("Private text remains while voice owns send");
  await captureSnapshot(page, "integrated-composer-voice-retry-draft");
  await shell.getByRole("button", { name: "Retry voice message", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(start).toBeVisible();
  const evidence = await page.evaluate(
    () =>
      (
        window as unknown as {
          __integratedVoice: {
            voice: Array<{ room: unknown; metadata: unknown; bytes: unknown }>;
            text: number;
          };
        }
      ).__integratedVoice,
  );
  expect(evidence.voice).toHaveLength(2);
  expect(evidence.voice[0]).toEqual(evidence.voice[1]);
  expect(evidence.voice[0].room).toBe(ROOM.room_id);
  expect(evidence.text).toBe(0);
  await editor.press("Enter");
  await expect(editor).toHaveText("");
  await expect(
    page.getByText("Private text remains while voice owns send", { exact: true }),
  ).toBeVisible();
  await start.click();
  await expect(page.getByLabel("Recording duration")).not.toHaveText("0:00");
  await shell.getByRole("button", { name: "Stop recording", exact: true }).click();
  await shell.getByRole("button", { name: "Discard recording", exact: true }).click();
  await expect(start).toBeFocused();
  await captureSnapshot(page, "integrated-composer-voice-discard");
});

test("staged drops and pastes wait behind voice without locking its send or losing the draft", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "charm:featureFlags",
      JSON.stringify({
        state: {
          overrides: { voice_recording: true, media_send_polish: true, ux_refresh_v1: true },
        },
        updatedAt: Date.now(),
      }),
    );
  });
  await page.addInitScript(installMockTauri, {
    userId: "@voice:localhost",
    deviceId: "VOICE_DEVICE",
    room: ROOM,
  });
  await page.goto("/");
  await page.getByRole("button", { name: ROOM.name }).click();
  await page.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    const sends: Array<{ room: unknown; voice: boolean; file: unknown }> = [];
    (window as unknown as { __stagedVoiceSends: typeof sends }).__stagedVoiceSends = sends;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "send_attachment")
        sends.push({ room: args?.roomId, voice: !!args?.voice, file: args?.filePath });
      return original(command, args);
    };
  });
  const shell = page.getByTestId("composer-shell");
  const editor = shell.locator('[contenteditable="true"]');
  await editor.fill("Keep the text draft and both media owners");
  await shell.getByRole("button", { name: "Record voice message", exact: true }).click();
  await expect(page.getByLabel("Recording duration")).not.toHaveText("0:00");
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["synthetic"], "pending.png", { type: "image/png" }));
    // Synthetic Tauri path extension; no host file or real upload is used.
    Object.defineProperty(data.files[0], "path", { value: "/synthetic/pending.png" });
    return data;
  });
  await page.getByTestId("chat-shell").dispatchEvent("drop", { dataTransfer: transfer });
  const attachment = page.getByRole("button", { name: "Send attachment", exact: true });
  await expect(attachment).toBeDisabled();
  await expect(shell.getByRole("button", { name: "Stop recording", exact: true })).toBeEnabled();
  await shell.getByRole("button", { name: "Stop recording", exact: true }).click();
  await expect(shell.getByLabel("Voice message preview")).toHaveAttribute("src", /^blob:/);
  const sendVoice = shell.getByRole("button", { name: "Send voice message", exact: true });
  await expect(sendVoice).toBeEnabled();
  await page.getByRole("button", { name: "Cancel attachment", exact: true }).click();
  const clipboard = await editor.evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(new File(["synthetic"], "pending.png", { type: "image/png" }));
    Object.defineProperty(data.files[0], "path", { value: "/synthetic/pending.png" });
    const event = new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    let bubbled = false;
    element.parentElement?.addEventListener(
      "paste",
      () => {
        bubbled = true;
      },
      { once: true },
    );
    element.dispatchEvent(event);
    return {
      files: event.clipboardData?.files.length,
      type: event.clipboardData?.files[0]?.type,
      prevented: event.defaultPrevented,
      bubbled,
    };
  });
  expect(clipboard.files).toBe(1);
  expect(clipboard.type).toBe("image/png");
  await expect(attachment, JSON.stringify(clipboard)).toBeDisabled();
  await expect(sendVoice).toBeEnabled();
  await editor.press("Enter");
  await expect(editor).toContainText("Keep the text draft and both media owners");
  await captureSnapshot(page, "integrated-composer-staged-file-voice-preview");
  await sendVoice.click();
  await expect(shell.getByLabel("Voice message preview")).toHaveCount(0);
  await expect(attachment).toBeEnabled();
  await attachment.click();
  await expect(attachment).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __stagedVoiceSends: Array<{ room: unknown; voice: boolean; file: unknown }>;
            }
          ).__stagedVoiceSends,
      ),
    )
    .toEqual([
      { room: ROOM.room_id, voice: true, file: "" },
      { room: ROOM.room_id, voice: false, file: "/synthetic/pending.png" },
    ]);
  await expect(editor).toContainText("Keep the text draft and both media owners");
});
