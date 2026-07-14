import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RichMessageContent, parseMatrixPillTarget } from "./RichMessageContent";

let clipboardWriteText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clipboardWriteText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWriteText },
  });
});

describe("RichMessageContent", () => {
  it("keeps spoiler content concealed until the user reveals it", () => {
    render(
      <RichMessageContent
        body="classified"
        formattedBody='<span data-mx-spoiler="plot twist">classified</span>'
        currentUserId="@me:localhost"
      />,
    );

    const spoiler = screen.getByRole("button", { name: "Reveal spoiler: plot twist" });
    expect(spoiler).toHaveClass("text-transparent");
    expect(spoiler).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(spoiler);
    expect(screen.getByRole("button", { name: "Hide spoiler" })).not.toHaveClass(
      "text-transparent",
    );
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
        ].join("")}
        currentUserId="@me:localhost"
      />,
    );

    await waitFor(() => expect(container.querySelectorAll("code[data-language]")).toHaveLength(5));
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
    expect(screen.getByText("@room").tagName).toBe("MARK");

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
