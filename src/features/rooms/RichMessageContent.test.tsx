import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RichMessageContent, parseMatrixPillTarget } from "./RichMessageContent";

const featureFlagMocks = vi.hoisted(() => ({ enabled: true }));

vi.mock("@/featureFlags", () => ({
  useFlag: () => featureFlagMocks.enabled,
}));

let clipboardWriteText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  featureFlagMocks.enabled = true;
  clipboardWriteText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWriteText },
  });
});

describe("RichMessageContent", () => {
  it("keeps staged enhancements disabled when the feature flag is off", () => {
    featureFlagMocks.enabled = false;
    const { container } = render(
      <RichMessageContent body="https://example.org 🎉" currentUserId="@me:localhost" />,
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(container.firstChild).not.toHaveAttribute("data-jumbo-emoji");
  });

  it("keeps spoiler content concealed until the user reveals it", () => {
    render(
      <RichMessageContent
        body="classified"
        formattedBody='<span data-mx-spoiler="plot twist">classified</span>'
        currentUserId="@me:localhost"
      />,
    );

    const spoiler = screen.getByRole("button", { name: "Reveal spoiler: plot twist" });
    expect(spoiler.previousElementSibling).toHaveClass("text-transparent");
    fireEvent.click(spoiler);
    expect(screen.queryByRole("button", { name: "Reveal spoiler: plot twist" })).toBeNull();
    expect(screen.getByText("classified")).not.toHaveClass("text-transparent");
  });

  it("forces rich spoiler descendants to stay concealed", () => {
    render(
      <RichMessageContent
        body="@room"
        formattedBody='<span data-mx-spoiler><a data-mx-pill href="https://matrix.to/#/%40alice%3Alocalhost">Alice</a> @room</span>'
        currentUserId="@me:localhost"
      />,
    );

    const spoiler = screen.getByRole("button", { name: "Reveal spoiler" });
    expect(spoiler.previousElementSibling).toHaveClass("[&_*]:!text-transparent");
    expect(spoiler.previousElementSibling).toHaveAttribute("inert");
    expect(screen.queryByRole("button", { name: "Alice" })).toBeNull();
    expect(screen.getByText("@room")).toBeInTheDocument();
    fireEvent.click(spoiler);
    expect(screen.getByText("@room").closest("[inert]")).toBeNull();
    expect(screen.getByRole("button", { name: "Alice" })).toBeInTheDocument();
  });

  it("renders a scrollable code block and copies its source", async () => {
    render(
      <RichMessageContent
        body={"const answer = 42;"}
        formattedBody={'<pre><code class="language-js">const answer = 42;</code></pre>'}
        currentUserId="@me:localhost"
      />,
    );

    expect(screen.getByText("const answer = 42;").closest("pre")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledWith("const answer = 42;"));
  });

  it("lazy-loads supported syntax grammars on demand", async () => {
    const { container } = render(
      <RichMessageContent
        body="examples"
        formattedBody={[
          '<pre><code class="language-bash">echo charm</code></pre>',
          '<pre><code class="language-css">.charm { color: red; }</code></pre>',
          '<pre><code class="language-json">{&quot;charm&quot;:true}</code></pre>',
          '<pre><code class="language-rust">let charm = true;</code></pre>',
          '<pre><code class="language-ts">const charm: boolean = true;</code></pre>',
          '<pre><code class="language-JavaScript">const mixedCase = true;</code></pre>',
        ].join("")}
        currentUserId="@me:localhost"
      />,
    );

    await waitFor(() => expect(container.querySelectorAll("code[data-language]")).toHaveLength(6));
    const mixedCaseCode = container.querySelector('code[data-language="javascript"]');
    expect(mixedCaseCode).toHaveTextContent("const mixedCase = true;");
  });

  it("wraps tables for horizontal scrolling and styles cells", () => {
    const { container } = render(
      <RichMessageContent
        body="Name Value A 1"
        formattedBody="<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr></tbody></table>"
        currentUserId="@me:localhost"
      />,
    );
    expect(container.querySelector("table")?.parentElement).toHaveClass("overflow-x-auto");
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveClass("border");
  });

  it("renders interactive user and room pills and highlights a self mention", () => {
    const onUserPillClick = vi.fn();
    const onRoomPillClick = vi.fn();
    render(
      <RichMessageContent
        body="Me General"
        formattedBody={
          '<a data-mx-pill href="https://matrix.to/#/%40me%3Alocalhost">Me</a> <a data-mx-pill href="https://matrix.to/#/%23general%3Alocalhost">General</a>'
        }
        currentUserId="@me:localhost"
        onUserPillClick={onUserPillClick}
        onRoomPillClick={onRoomPillClick}
      />,
    );

    const user = screen.getByRole("button", { name: "Me" });
    expect(user).toHaveClass("bg-primary-solid");
    fireEvent.click(user);
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    expect(onUserPillClick).toHaveBeenCalledWith("@me:localhost", "Me");
    expect(onRoomPillClick).toHaveBeenCalledWith("#general:localhost");
  });

  it("highlights @room and @here in formatted and plain messages", () => {
    const { rerender } = render(
      <RichMessageContent body="Attention @room" currentUserId="@me:localhost" />,
    );
    expect(screen.getByText("@room")).toHaveClass("bg-warning-solid", "text-white");

    rerender(
      <RichMessageContent
        body="Attention @here"
        formattedBody="<strong>Attention @here</strong>"
        currentUserId="@me:localhost"
      />,
    );
    expect(screen.getByText("@here").tagName).toBe("MARK");
  });

  it("loads KaTeX for Matrix math nodes", async () => {
    const { container } = render(
      <RichMessageContent
        body="x squared"
        formattedBody='<span data-mx-maths="x^2">x squared</span>'
        currentUserId="@me:localhost"
      />,
    );
    await waitFor(() => expect(container.querySelector(".katex")).toBeInTheDocument());
  });

  it("scales emoji-only messages but not mixed text", () => {
    const { container, rerender } = render(
      <RichMessageContent body="🎉✨" currentUserId="@me:localhost" />,
    );
    expect(container.firstChild).toHaveAttribute("data-jumbo-emoji", "true");
    rerender(<RichMessageContent body="great 🎉" currentUserId="@me:localhost" />);
    expect(container.firstChild).not.toHaveAttribute("data-jumbo-emoji");
  });

  it("uses the rendered formatted text when deciding whether to scale emoji", () => {
    const { container } = render(
      <RichMessageContent
        body="🎉"
        formattedBody="<strong>not actually emoji-only</strong>"
        currentUserId="@me:localhost"
      />,
    );
    expect(container.firstChild).not.toHaveAttribute("data-jumbo-emoji");
  });

  it("renders relative and fragment links as non-interactive text", () => {
    const { container } = render(
      <RichMessageContent
        body="Relative Fragment"
        formattedBody='<a href="/settings">Relative</a> <a href="#section">Fragment</a>'
        currentUserId="@me:localhost"
      />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("Relative").tagName).toBe("SPAN");
    expect(screen.getByText("Fragment").tagName).toBe("SPAN");
  });

  it("sanitizes remote markup before parsing it into React", () => {
    const { container } = render(
      <RichMessageContent
        body="safe"
        formattedBody='<img src="https://tracker.example/pixel" onerror="alert(1)"><script>alert(1)</script><b>safe</b>'
        currentUserId="@me:localhost"
      />,
    );
    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect(container.querySelector("img")).not.toHaveAttribute("src");
    expect(screen.getByText("safe").tagName).toBe("B");
  });
});

describe("parseMatrixPillTarget", () => {
  it("recognizes matrix.to user and room targets", () => {
    expect(parseMatrixPillTarget("https://matrix.to/#/%40alice%3Aexample.org")).toEqual({
      kind: "user",
      identifier: "@alice:example.org",
    });
    expect(parseMatrixPillTarget("https://matrix.to/#/%23general%3Aexample.org")).toEqual({
      kind: "room",
      identifier: "#general:example.org",
    });
  });
});
