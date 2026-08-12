import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmojiClickData, PickerProps } from "emoji-picker-react";
import { createStore, Provider } from "jotai";
import { themeAtom } from "@/features/appearance/atoms";
import { EmojiPicker, EmojiPickerPanel, emojiPickerTheme } from "./EmojiPicker";

const mocks = vi.hoisted(() => ({ fullPickerEnabled: false }));

vi.mock("@/featureFlags", () => ({
  useFlag: (key: string) => key === "full_emoji_picker" && mocks.fullPickerEnabled,
}));

vi.mock("emoji-picker-react", () => ({
  default: (props: PickerProps) => (
    <div
      data-testid="full-emoji-picker"
      data-theme={String(props.theme)}
      data-style={String(props.emojiStyle)}
      data-suggestions={String(props.suggestedEmojisMode)}
      data-categories={(props.categories ?? []).map((category) => category.category).join(",")}
      data-search-disabled={String(props.searchDisabled ?? false)}
      data-skin-tones-disabled={String(props.skinTonesDisabled ?? false)}
      data-custom-names={(props.customEmojis ?? []).flatMap((emoji) => emoji.names).join(",")}
    >
      <button
        type="button"
        onClick={() =>
          props.onEmojiClick?.({ emoji: "🧭" } as EmojiClickData, new MouseEvent("click"))
        }
      >
        Select mocked emoji
      </button>
    </div>
  ),
}));

describe("EmojiPicker", () => {
  beforeEach(() => {
    mocks.fullPickerEnabled = false;
    localStorage.clear();
  });

  it("retains the compact picker while the full picker flag is disabled", async () => {
    const onSelect = vi.fn();
    render(
      <EmojiPicker accountId="@alice:example.org" onSelect={onSelect}>
        <button type="button">Open emoji picker</button>
      </EmojiPicker>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open emoji picker" }));
    fireEvent.click(await screen.findByRole("button", { name: "React with 👍" }));

    expect(onSelect).toHaveBeenCalledWith("👍");
    expect(screen.getByRole("button", { name: "React with 👍" })).toBeInTheDocument();
  });

  it("configures the lazy full picker and forwards custom emoji categories", async () => {
    mocks.fullPickerEnabled = true;
    const onSelect = vi.fn();
    const store = createStore();
    store.set(themeAtom, "light");
    render(
      <Provider store={store}>
        <EmojiPicker
          accountId="@alice:example.org"
          onSelect={onSelect}
          extraCategories={[
            {
              id: "cloudhub",
              name: "CloudHub",
              emojis: [{ id: "charm", names: ["charm"], imgUrl: "https://example.test/charm.png" }],
            },
          ]}
        >
          <button type="button">Open emoji picker</button>
        </EmojiPicker>
      </Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open emoji picker" }));
    const picker = await screen.findByTestId("full-emoji-picker");

    expect(picker).toHaveAttribute("data-theme", "light");
    expect(picker).toHaveAttribute("data-style", "native");
    expect(picker).toHaveAttribute("data-suggestions", "undefined");
    expect(picker.getAttribute("data-categories")?.split(",")).not.toContain("suggested");
    expect(picker).toHaveAttribute("data-search-disabled", "false");
    expect(picker).toHaveAttribute("data-skin-tones-disabled", "false");
    expect(picker).toHaveAttribute("data-custom-names", "charm,CloudHub,cloudhub");

    act(() => store.set(themeAtom, "system"));
    await waitFor(() => expect(picker).toHaveAttribute("data-theme", "auto"));

    fireEvent.click(screen.getByRole("button", { name: "Select mocked emoji" }));
    expect(onSelect).toHaveBeenCalledWith("🧭");
    await waitFor(() => expect(screen.queryByTestId("full-emoji-picker")).not.toBeInTheDocument());
  });

  it("keeps recent emoji partitioned by Matrix account", async () => {
    mocks.fullPickerEnabled = true;
    const view = render(<EmojiPickerPanel accountId="@alice:example.org" onSelect={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Select mocked emoji" }));
    expect(screen.getByRole("button", { name: "Recently used 🧭" })).toBeInTheDocument();
    expect(localStorage.getItem("epr_suggested")).toBeNull();

    view.rerender(<EmojiPickerPanel accountId="@bob:example.org" onSelect={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Recently used 🧭" })).not.toBeInTheDocument();
  });

  it("contains Escape so the surrounding composer does not cancel", async () => {
    mocks.fullPickerEnabled = true;
    const documentEscape = vi.fn();
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") documentEscape();
    };
    document.addEventListener("keydown", listener);

    try {
      render(
        <EmojiPicker accountId="@alice:example.org" onSelect={vi.fn()}>
          <button type="button">Open emoji picker</button>
        </EmojiPicker>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Open emoji picker" }));
      const picker = await screen.findByTestId("full-emoji-picker");

      fireEvent.keyDown(picker, { key: "Escape" });

      expect(documentEscape).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", listener);
    }
  });

  it("maps every Charm appearance choice to the matching picker theme", () => {
    expect(emojiPickerTheme("dark")).toBe("dark");
    expect(emojiPickerTheme("light")).toBe("light");
    expect(emojiPickerTheme("midnight")).toBe("dark");
    expect(emojiPickerTheme("system")).toBe("auto");
  });
});
