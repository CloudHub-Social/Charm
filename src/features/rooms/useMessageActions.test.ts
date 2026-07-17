import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useMessageActions } from "./useMessageActions";
import { makeMessageSummary } from "./testFixtures";

const toggleReaction = vi.fn();
const redactEvent = vi.fn();
const resendMessage = vi.fn();
const discardFailedMessage = vi.fn();
const pinEvent = vi.fn();
const unpinEvent = vi.fn();

vi.mock("@/lib/matrix", () => ({
  toggleReaction: (...args: unknown[]) => toggleReaction(...args),
  redactEvent: (...args: unknown[]) => redactEvent(...args),
  resendMessage: (...args: unknown[]) => resendMessage(...args),
  discardFailedMessage: (...args: unknown[]) => discardFailedMessage(...args),
  pinEvent: (...args: unknown[]) => pinEvent(...args),
  unpinEvent: (...args: unknown[]) => unpinEvent(...args),
}));

function setup(roomId: string | null = "!room:localhost") {
  const setReplyTarget = vi.fn();
  const setEditingEventId = vi.fn();
  const { result } = renderHook(() =>
    useMessageActions({ roomId, setReplyTarget, setEditingEventId }),
  );
  return { ...result.current, setReplyTarget, setEditingEventId };
}

describe("useMessageActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handleToggleReaction calls toggleReaction with the room, event, and key", async () => {
    const { handleToggleReaction } = setup();
    await handleToggleReaction("$1", "👍");
    expect(toggleReaction).toHaveBeenCalledWith("!room:localhost", "$1", "👍");
  });

  it("handleToggleReaction is a no-op with no active room", async () => {
    const { handleToggleReaction } = setup(null);
    await handleToggleReaction("$1", "👍");
    expect(toggleReaction).not.toHaveBeenCalled();
  });

  it("handleToggleReaction swallows errors", async () => {
    toggleReaction.mockRejectedValueOnce(new Error("network"));
    const { handleToggleReaction } = setup();
    await expect(handleToggleReaction("$1", "👍")).resolves.toBeUndefined();
  });

  it("handleDelete redacts and returns true on success", async () => {
    const { handleDelete } = setup();
    const ok = await handleDelete("$1", "spam");
    expect(redactEvent).toHaveBeenCalledWith("!room:localhost", "$1", "spam");
    expect(ok).toBe(true);
  });

  it("handleDelete returns false with no active room", async () => {
    const { handleDelete } = setup(null);
    expect(await handleDelete("$1")).toBe(false);
    expect(redactEvent).not.toHaveBeenCalled();
  });

  it("handleDelete returns false and swallows errors", async () => {
    redactEvent.mockRejectedValueOnce(new Error("network"));
    const { handleDelete } = setup();
    expect(await handleDelete("$1")).toBe(false);
  });

  it("handleReply sets the reply target from the message", () => {
    const { handleReply, setReplyTarget } = setup();
    const message = makeMessageSummary({
      event_id: "$1",
      sender: "@bob:localhost",
      sender_display_name: "Bob",
      body: "hi",
    });
    handleReply(message);
    expect(setReplyTarget).toHaveBeenCalledWith({
      event_id: "$1",
      sender: "@bob:localhost",
      sender_display_name: "Bob",
      preview: "hi",
    });
  });

  it("handleEdit clears the reply target and sets the editing event id", () => {
    const { handleEdit, setReplyTarget, setEditingEventId } = setup();
    handleEdit("$1");
    expect(setReplyTarget).toHaveBeenCalledWith(null);
    expect(setEditingEventId).toHaveBeenCalledWith("$1");
  });

  it("handleResend retries the send queue for the given transaction id", async () => {
    const { handleResend } = setup();
    await handleResend("txn-1");
    expect(resendMessage).toHaveBeenCalledWith("!room:localhost", "txn-1");
  });

  it("handleResend is a no-op with no active room", async () => {
    const { handleResend } = setup(null);
    await handleResend("txn-1");
    expect(resendMessage).not.toHaveBeenCalled();
  });

  it("handleResend swallows errors", async () => {
    resendMessage.mockRejectedValueOnce(new Error("network"));
    const { handleResend } = setup();
    await expect(handleResend("txn-1")).resolves.toBeUndefined();
  });

  it("handleDiscard discards the failed local echo", async () => {
    const { handleDiscard } = setup();
    await handleDiscard("txn-1");
    expect(discardFailedMessage).toHaveBeenCalledWith("!room:localhost", "txn-1");
  });

  it("handleDiscard is a no-op with no active room", async () => {
    const { handleDiscard } = setup(null);
    await handleDiscard("txn-1");
    expect(discardFailedMessage).not.toHaveBeenCalled();
  });

  it("handleDiscard swallows errors", async () => {
    discardFailedMessage.mockRejectedValueOnce(new Error("network"));
    const { handleDiscard } = setup();
    await expect(handleDiscard("txn-1")).resolves.toBeUndefined();
  });

  // --- Spec day-2/04: message pinning ---

  it("handlePin pins the given event in the active room", async () => {
    const { handlePin } = setup();
    await handlePin("$1");
    expect(pinEvent).toHaveBeenCalledWith("!room:localhost", "$1");
  });

  it("handlePin is a no-op with no active room", async () => {
    const { handlePin } = setup(null);
    await handlePin("$1");
    expect(pinEvent).not.toHaveBeenCalled();
  });

  it("handlePin swallows errors", async () => {
    pinEvent.mockRejectedValueOnce(new Error("network"));
    const { handlePin } = setup();
    await expect(handlePin("$1")).resolves.toBeUndefined();
  });

  it("handleUnpin unpins the given event in the active room", async () => {
    const { handleUnpin } = setup();
    await handleUnpin("$1");
    expect(unpinEvent).toHaveBeenCalledWith("!room:localhost", "$1");
  });

  it("handleUnpin is a no-op with no active room", async () => {
    const { handleUnpin } = setup(null);
    await handleUnpin("$1");
    expect(unpinEvent).not.toHaveBeenCalled();
  });

  it("handleUnpin swallows errors", async () => {
    unpinEvent.mockRejectedValueOnce(new Error("network"));
    const { handleUnpin } = setup();
    await expect(handleUnpin("$1")).resolves.toBeUndefined();
  });
});
