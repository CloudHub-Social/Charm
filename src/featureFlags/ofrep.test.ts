import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRemoteFlags, isRemoteConfigured, parseRemoteFlags } from "./ofrep";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("parseRemoteFlags", () => {
  it("keeps only boolean values for known catalog keys", () => {
    const remote = parseRemoteFlags({
      flags: [
        { key: "canary", value: true },
        { key: "room_invites", value: false },
        { key: "not_a_flag", value: true }, // unknown key → dropped
        { key: "mobile_chat_redesign", value: "on" }, // non-boolean → dropped
      ],
    });
    expect(remote).toEqual({ canary: true, room_invites: false });
  });

  it("drops flags that evaluated with an error", () => {
    const remote = parseRemoteFlags({
      flags: [{ key: "canary", value: true, errorCode: "FLAG_NOT_FOUND" }],
    });
    expect(remote).toEqual({});
  });

  it("tolerates a missing flags array", () => {
    expect(parseRemoteFlags({})).toEqual({});
  });
});

describe("isRemoteConfigured", () => {
  it("is false when the endpoint env var is unset", () => {
    vi.stubEnv("VITE_CHARM_OFREP_URL", "");
    expect(isRemoteConfigured()).toBe(false);
  });

  it("is true when configured", () => {
    vi.stubEnv("VITE_CHARM_OFREP_URL", "https://flags.example.com");
    expect(isRemoteConfigured()).toBe(true);
  });
});

describe("fetchRemoteFlags", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_CHARM_OFREP_URL", "https://flags.example.com/");
  });

  it("posts the targeting key and returns the parsed map on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ flags: [{ key: "canary", value: true }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchRemoteFlags("install-123");
    expect(result).toEqual({ canary: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://flags.example.com/ofrep/v1/evaluate/flags");
    expect(JSON.parse(init.body)).toEqual({ context: { targetingKey: "install-123" } });
  });

  it("returns null (fail-open) on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    expect(await fetchRemoteFlags("x")).toBeNull();
  });

  it("returns null (fail-open) on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await fetchRemoteFlags("x")).toBeNull();
  });

  it("returns null when no endpoint is configured", async () => {
    vi.stubEnv("VITE_CHARM_OFREP_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchRemoteFlags("x")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
