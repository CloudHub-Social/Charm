import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { messageLayoutAtom } from "@/features/appearance/atoms";
import type { MessageLayout } from "@/features/appearance/atoms";
import type * as FeatureFlagsModule from "@/featureFlags";
import type * as MatrixModule from "@/lib/matrix";
import { MessageRow } from "./MessageRow";
import { makeMessageSummary } from "./testFixtures";

const getUrlPreview = vi.fn();

vi.mock("@/lib/matrix", async () => {
  const actual = await vi.importActual<typeof MatrixModule>("@/lib/matrix");
  return { ...actual, getUrlPreview: (...args: unknown[]) => getUrlPreview(...args) };
});

// Force the link_previews flag on so the "no URL -> no fetch" test below
// proves the URL-detection short-circuit in LinkPreviewForMessage, not
// merely that the flag happened to be off.
vi.mock("@/featureFlags", async () => {
  const actual = await vi.importActual<typeof FeatureFlagsModule>("@/featureFlags");
  return { ...actual, useFlag: () => true };
});

function renderRow(messageLayout: MessageLayout, body = "hello") {
  const store = createStore();
  store.set(messageLayoutAtom, messageLayout);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Provider store={store}>
        <MessageRow
          message={makeMessageSummary({
            event_id: "$1",
            sender: "@bob:localhost",
            sender_display_name: "Bob",
            body,
          })}
          roomId="!room:localhost"
          own={false}
          sameSenderAsPrev={false}
          sameSenderAsNext={false}
          canRedact={false}
          readers={[]}
          senderNameByUserId={new Map()}
          isNew={false}
          getActionsHandle={() => undefined}
          registerActionsRef={vi.fn()}
          onReply={vi.fn()}
          onReact={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onCopy={vi.fn()}
          onJumpToMessage={vi.fn()}
        />
      </Provider>
    </QueryClientProvider>,
  );
}

describe("MessageRow dispatcher", () => {
  it("defaults to bubble mode — the current/shipped bubble background renders", () => {
    const { container } = renderRow("bubble");
    expect(container.querySelector(".bg-secondary")).toBeInTheDocument();
  });

  it("mounts DiscordMessageRow when messageLayout is discord — header line, no bubble", () => {
    const { container } = renderRow("discord");
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(container.querySelector(".bg-secondary")).not.toBeInTheDocument();
  });

  it("mounts IrcMessageRow when messageLayout is irc — [HH:MM] <nick> body format", () => {
    renderRow("irc");
    expect(screen.getByText("<Bob>")).toBeInTheDocument();
  });
});

describe("MessageRow link previews (Spec 29)", () => {
  it("never fetches a preview for a message body with no URL, even with the flag on", async () => {
    renderRow("bubble", "just a plain message, nothing to unfurl here");

    // Give any would-be effect a tick to fire before asserting it didn't.
    await waitFor(() => expect(screen.getByText(/just a plain message/)).toBeInTheDocument());
    expect(getUrlPreview).not.toHaveBeenCalled();
  });

  it("fetches a preview when the body does contain a URL and the flag is on", async () => {
    getUrlPreview.mockResolvedValueOnce(null);
    renderRow("bubble", "check this out https://example.com");

    await waitFor(() =>
      expect(getUrlPreview).toHaveBeenCalledWith("!room:localhost", "https://example.com"),
    );
  });
});
