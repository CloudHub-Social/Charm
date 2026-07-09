import { expect, type APIRequestContext, type Page, test } from "@playwright/test";

// snapshot-exempt: live-gated Matrix E2EE round trip against Synapse/charm-web-server;
// the deterministic visual states are covered by component and normal e2e specs.
const enabled = process.env.CHARM_LIVE_WEB_E2EE === "1";
const homeserver = process.env.CHARM_LIVE_HOMESERVER ?? "http://localhost:8008";
const apiBase = process.env.VITE_CHARM_WEB_API_BASE_URL ?? "";
const password = process.env.CHARM_LIVE_WEB_PASSWORD ?? "testpass123";

test.skip(
  !enabled,
  "Set CHARM_LIVE_WEB_E2EE=1 with a local Synapse and charm-web-server to run the live web E2EE check.",
);

type RegisterResponse = {
  access_token: string;
  user_id: string;
};

declare global {
  interface Window {
    __charmLiveApiBase: string;
  }
}

async function registerUser(
  request: APIRequestContext,
  username: string,
): Promise<RegisterResponse> {
  const body = {
    username,
    password,
    auth: { type: "m.login.dummy" },
  };
  let response = await request.post(`${homeserver}/_matrix/client/v3/register`, {
    data: body,
  });

  if (response.status() === 401) {
    const challenge = await response.json();
    response = await request.post(`${homeserver}/_matrix/client/v3/register`, {
      data: {
        ...body,
        auth: { type: "m.login.dummy", session: challenge.session },
      },
    });
  }

  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as RegisterResponse;
}

async function createEncryptedRoom(
  request: APIRequestContext,
  accessToken: string,
  name: string,
): Promise<string> {
  const response = await request.post(`${homeserver}/_matrix/client/v3/createRoom`, {
    headers: { authorization: `Bearer ${accessToken}` },
    data: {
      name,
      preset: "private_chat",
      initial_state: [
        {
          type: "m.room.encryption",
          state_key: "",
          content: { algorithm: "m.megolm.v1.aes-sha2" },
        },
      ],
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const body = (await response.json()) as { room_id: string };
  return body.room_id;
}

async function signIn(page: Page, username: string) {
  await page.goto("/");
  await expect(page.getByText("Sign in to your homeserver")).toBeVisible();
  await page.getByLabel("Homeserver").fill(homeserver);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function currentDeviceId(page: Page): Promise<string> {
  const auth = await page.evaluate(async () => {
    const response = await fetch(`${window.__charmLiveApiBase}/api/auth/me`, {
      credentials: "include",
      headers: { "x-charm-operation-id": "live-web-e2ee-current-device" },
    });
    return (await response.json()) as { device_id: string };
  });
  return auth.device_id;
}

async function bootstrapFromSettings(page: Page) {
  await expect(page.getByRole("button", { name: "Open settings" })).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.getByRole("tab", { name: "Devices" }).click();

  await page.getByRole("button", { name: "Set up" }).click();
  const passwordPrompt = page.getByLabel("Account password");
  if (await passwordPrompt.isVisible().catch(() => false)) {
    await passwordPrompt.fill(password);
    await page.getByRole("button", { name: "Confirm" }).click();
  }
  await expect(page.getByText("Cross-signing is set up.")).toBeVisible({
    timeout: 30_000,
  });
}

test("fresh web session verifies against another session and decrypts E2EE", async ({
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const username = `web_e2ee_${suffix}`;
  const roomName = `Encrypted web ${suffix}`;
  const message = `encrypted hello ${suffix}`;
  const registration = await registerUser(request, username);

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  await contextA.addInitScript((base) => {
    window.__charmLiveApiBase = base;
  }, apiBase);
  await contextB.addInitScript((base) => {
    window.__charmLiveApiBase = base;
  }, apiBase);
  await contextA.addInitScript((userId) => {
    localStorage.setItem(`charm:onboarding-complete:${userId}`, "true");
  }, registration.user_id);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await signIn(pageA, username);
  await expect(pageA.getByText("No rooms yet")).toBeVisible();
  await bootstrapFromSettings(pageA);
  const deviceAId = await currentDeviceId(pageA);

  await signIn(pageB, username);
  await expect(pageB.getByRole("heading", { name: "Welcome to Charm" })).toBeVisible();
  await expect(pageB.getByRole("button", { name: "Continue" })).toBeEnabled();
  await pageB.getByRole("button", { name: "Continue" }).click();
  await expect(pageB.getByRole("heading", { name: "Verify this device" })).toBeVisible();

  await pageB.getByRole("button", { name: `Verify with ${deviceAId}` }).click();
  await expect(pageA.getByText("Verify new sign-in")).toBeVisible({ timeout: 30_000 });
  await pageA.getByRole("button", { name: "Accept" }).click();
  await expect(pageB.getByText("Verify new sign-in")).toBeVisible({ timeout: 30_000 });
  await pageB.getByRole("button", { name: "Accept" }).click();

  await expect(pageA.getByText("Do these emoji match?")).toBeVisible({ timeout: 30_000 });
  await expect(pageB.getByText("Do these emoji match?")).toBeVisible({ timeout: 30_000 });
  await pageA.getByRole("button", { name: "They match" }).click();
  await pageB.getByRole("button", { name: "They match" }).click();
  await expect(pageA.getByText("Verified")).toBeVisible({ timeout: 30_000 });
  await expect(pageB.getByText("Verified")).toBeVisible({ timeout: 30_000 });

  await expect(pageB.getByText("This device is set up and trusted.")).toBeVisible({
    timeout: 30_000,
  });
  await pageB.getByRole("button", { name: "Continue" }).click();
  await expect(pageB.getByText("Say hello")).toBeVisible({ timeout: 30_000 });
  await pageB.getByRole("button", { name: "Not now" }).click();
  await expect(pageB.getByRole("button", { name: "Open settings" })).toBeVisible();

  await createEncryptedRoom(request, registration.access_token, roomName);
  await expect(pageA.getByRole("button", { name: roomName })).toBeVisible({ timeout: 30_000 });
  await expect(pageB.getByRole("button", { name: roomName })).toBeVisible({ timeout: 30_000 });

  await pageB.getByRole("button", { name: roomName }).click();
  await expect(pageB.getByText("No messages yet")).toBeVisible();
  await pageA.getByRole("button", { name: roomName }).click();
  await pageA.getByPlaceholder(`Message ${roomName}`).fill(message);
  await pageA.getByRole("button", { name: "Send" }).click();

  await expect(pageB.getByText("Unable to decrypt message")).toHaveCount(0);
  await expect(pageB.getByText(message, { exact: true })).toBeVisible({ timeout: 45_000 });

  await contextA.close();
  await contextB.close();
});
