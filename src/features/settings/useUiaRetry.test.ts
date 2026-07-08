import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useUiaRetry } from "./useUiaRetry";

describe("useUiaRetry", () => {
  it("prompts for a password when the action rejects with a UIA challenge", async () => {
    const action = vi.fn().mockRejectedValue({ kind: "UiaChallenge" });
    const { result } = renderHook(() => useUiaRetry(action));

    let succeeded: boolean | undefined;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(false);
    expect(result.current.needsPassword).toBe(true);
    expect(result.current.error).toBeNull();
    expect(action).toHaveBeenLastCalledWith(undefined);
  });

  it("surfaces a non-UIA error instead of prompting for a password", async () => {
    const action = vi.fn().mockRejectedValue({ kind: "Other", message: "network error" });
    const { result } = renderHook(() => useUiaRetry(action));

    let succeeded: boolean | undefined;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(false);
    expect(result.current.needsPassword).toBe(false);
    expect(result.current.error).toBe("network error");
  });

  it("retries with the password once needsPassword is set, and succeeds", async () => {
    const action = vi
      .fn()
      .mockRejectedValueOnce({ kind: "UiaChallenge" })
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useUiaRetry(action));

    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.needsPassword).toBe(true);

    act(() => {
      result.current.setPassword("current-password");
    });

    let succeeded: boolean | undefined;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(true);
    expect(result.current.error).toBeNull();
    expect(action).toHaveBeenLastCalledWith("current-password");
  });

  it("treats an error that isn't a structured UiaCommandError as a plain error", async () => {
    const action = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useUiaRetry(action));

    await act(async () => {
      await result.current.submit();
    });

    expect(result.current.needsPassword).toBe(false);
    expect(result.current.error).toBe("Error: boom");
  });

  it("reset clears password, needsPassword, and error", async () => {
    const action = vi.fn().mockRejectedValue({ kind: "UiaChallenge" });
    const { result } = renderHook(() => useUiaRetry(action));

    await act(async () => {
      await result.current.submit();
    });
    act(() => {
      result.current.setPassword("secret");
    });
    expect(result.current.needsPassword).toBe(true);

    act(() => {
      result.current.reset();
    });

    expect(result.current.needsPassword).toBe(false);
    expect(result.current.password).toBe("");
    expect(result.current.error).toBeNull();
  });
});
