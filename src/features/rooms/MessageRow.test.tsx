import { render, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { messageLayoutAtom } from "@/features/appearance/atoms";
import type { MessageLayout } from "@/features/appearance/atoms";
import { MessageRow } from "./MessageRow";
import { makeMessageSummary } from "./testFixtures";

function renderRow(messageLayout: MessageLayout) {
  const store = createStore();
  store.set(messageLayoutAtom, messageLayout);
  return render(
    <Provider store={store}>
      <MessageRow
        message={makeMessageSummary({
          event_id: "$1",
          sender: "@bob:localhost",
          sender_display_name: "Bob",
          body: "hello",
        })}
        roomId="!room:localhost"
        own={false}
        sameSenderAsPrev={false}
        sameSenderAsNext={false}
        canRedact={false}
        readers={[]}
        getActionsHandle={() => undefined}
        registerActionsRef={vi.fn()}
        onReply={vi.fn()}
        onReact={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onCopy={vi.fn()}
      />
    </Provider>,
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
