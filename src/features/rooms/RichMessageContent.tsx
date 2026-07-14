import emojiRegex from "emoji-regex";
import parse, {
  attributesToProps,
  domToReact,
  Element,
  Text,
  type DOMNode,
  type HTMLReactParserOptions,
} from "html-react-parser";
import Linkify from "linkify-react";
import { Check, Copy } from "lucide-react";
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { jumboEmojiSizeAtom } from "@/features/appearance/atoms";
import { logAndIgnore } from "@/lib/logAndIgnore";
import { openExternalUrl } from "@/lib/openExternalUrl";
import { cn } from "@/lib/utils";
import { sanitizeMatrixHtml } from "./composerSanitize";
import { avatarColor, initials } from "./roomDisplay";

const ROOM_MENTION_RE = /(@room|@here)/gi;
const MATRIX_TO_PREFIX = "https://matrix.to/#/";
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

export type MatrixPillTarget =
  | { kind: "user"; identifier: string }
  | { kind: "room"; identifier: string };

interface RichMessageContentProps {
  body: string;
  formattedBody?: string | null;
  currentUserId: string;
  className?: string;
  onUserPillClick?: (userId: string, label: string) => void;
  onRoomPillClick?: (roomIdentifier: string) => void;
}

function isOnlyEmoji(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  const withoutEmoji = normalized.replace(emojiRegex(), "").replace(/[\s\uFE0F\u200D]/g, "");
  if (withoutEmoji !== "") return false;
  return [...normalized.matchAll(emojiRegex())].length <= 6;
}

function highlightRoomMentions(text: string): ReactNode {
  const parts = text.split(ROOM_MENTION_RE);
  if (parts.length === 1) return text;
  let offset = 0;
  return (
    <>
      {parts.map((part) => {
        const key = `${offset}:${part}`;
        offset += part.length;
        return /^@(room|here)$/i.test(part) ? (
          <mark key={key} className="rounded bg-warning-solid px-0.5 font-semibold text-white">
            {part}
          </mark>
        ) : (
          part
        );
      })}
    </>
  );
}

export function parseMatrixPillTarget(href: string | undefined): MatrixPillTarget | null {
  if (!href) return null;
  let identifier = href;
  if (href.startsWith(MATRIX_TO_PREFIX)) {
    try {
      identifier = decodeURIComponent(href.slice(MATRIX_TO_PREFIX.length).split("?")[0]);
    } catch {
      return null;
    }
  }

  if (identifier.startsWith("@")) return { kind: "user", identifier };
  if (identifier.startsWith("#") || identifier.startsWith("!")) {
    return { kind: "room", identifier };
  }
  return null;
}

function Spoiler({ reason, children }: { reason?: string; children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span className="relative inline-block rounded">
      <span
        aria-hidden={!revealed}
        inert={!revealed ? true : undefined}
        className={cn(
          "rounded px-1",
          revealed
            ? "bg-muted text-foreground"
            : "pointer-events-none bg-foreground text-transparent select-none [&_*]:!text-transparent",
        )}
      >
        {children}
      </span>
      {!revealed && (
        <button
          type="button"
          aria-label={reason ? `Reveal spoiler: ${reason}` : "Reveal spoiler"}
          title={reason}
          onClick={() => setRevealed(true)}
          className="absolute inset-0 rounded bg-foreground transition-colors hover:bg-foreground/80"
        />
      )}
    </span>
  );
}

type HighlightResult = { html: string | null; language: string | null };

async function highlightCode(code: string, language: string | null): Promise<HighlightResult> {
  if (!language) return { html: null, language: null };
  const core = (await import("highlight.js/lib/core")).default;
  const loaders: Record<
    string,
    () => Promise<{ default: Parameters<typeof core.registerLanguage>[1] }>
  > = {
    bash: () => import("highlight.js/lib/languages/bash"),
    css: () => import("highlight.js/lib/languages/css"),
    html: () => import("highlight.js/lib/languages/xml"),
    javascript: () => import("highlight.js/lib/languages/javascript"),
    js: () => import("highlight.js/lib/languages/javascript"),
    json: () => import("highlight.js/lib/languages/json"),
    markdown: () => import("highlight.js/lib/languages/markdown"),
    rust: () => import("highlight.js/lib/languages/rust"),
    ts: () => import("highlight.js/lib/languages/typescript"),
    typescript: () => import("highlight.js/lib/languages/typescript"),
    xml: () => import("highlight.js/lib/languages/xml"),
  };
  const normalizedLanguage = language.toLowerCase();
  const load = loaders[normalizedLanguage];
  if (!load) return { html: null, language: null };
  core.registerLanguage(normalizedLanguage, (await load()).default);
  await import("highlight.js/styles/github-dark.css");
  return {
    html: core.highlight(code, { language: normalizedLanguage }).value,
    language: normalizedLanguage,
  };
}

function CodeBlock({ code, language }: { code: string; language: string | null }) {
  const [highlighted, setHighlighted] = useState<HighlightResult>({ html: null, language: null });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    highlightCode(code, language)
      .then((result) => {
        if (active) setHighlighted(result);
      })
      .catch(logAndIgnore);
    return () => {
      active = false;
    };
  }, [code, language]);

  async function copyCode() {
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      logAndIgnore(error);
    }
  }

  return (
    <div className="group/code relative my-2 max-w-full overflow-x-auto rounded-md border border-border bg-muted/60">
      <button
        type="button"
        aria-label="Copy code"
        onClick={() => void copyCode()}
        className="sticky top-2 float-right mr-2 flex size-7 items-center justify-center rounded bg-background/90 text-muted-foreground shadow-sm hover:text-foreground"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      <pre className="min-w-max p-3 pr-11 font-mono text-xs leading-relaxed">
        <code
          data-language={highlighted.language ?? undefined}
          className={highlighted.html === null ? undefined : "hljs"}
        >
          {highlighted.html === null ? code : parse(highlighted.html)}
        </code>
      </pre>
    </div>
  );
}

function MathContent({ tex, display }: { tex: string; display: boolean }) {
  const [content, setContent] = useState<ReactNode>(tex);

  useEffect(() => {
    let active = true;
    Promise.all([import("katex"), import("katex/dist/katex.min.css")])
      .then(([katex]) => {
        if (!active) return;
        const html = katex.default.renderToString(tex, {
          displayMode: display,
          throwOnError: false,
          trust: false,
          strict: "warn",
        });
        setContent(parse(html));
      })
      .catch(logAndIgnore);
    return () => {
      active = false;
    };
  }, [display, tex]);

  const Component = display ? "div" : "span";
  return <Component className={display ? "my-2 overflow-x-auto" : undefined}>{content}</Component>;
}

function MatrixPill({
  target,
  label,
  currentUserId,
  onUserPillClick,
  onRoomPillClick,
}: {
  target: MatrixPillTarget;
  label: string;
  currentUserId: string;
  onUserPillClick?: RichMessageContentProps["onUserPillClick"];
  onRoomPillClick?: RichMessageContentProps["onRoomPillClick"];
}) {
  const selfMention = target.kind === "user" && target.identifier === currentUserId;
  return (
    <button
      type="button"
      onClick={() => {
        if (target.kind === "user") onUserPillClick?.(target.identifier, label);
        else onRoomPillClick?.(target.identifier);
      }}
      className={cn(
        "mx-0.5 inline-flex max-w-full items-center gap-1 rounded-full px-1.5 py-0.5 align-middle text-xs font-semibold",
        selfMention
          ? "bg-primary-solid text-primary-foreground"
          : "bg-accent text-accent-foreground hover:bg-accent/70",
      )}
    >
      {target.kind === "user" && (
        <span
          aria-hidden="true"
          className="flex size-4 shrink-0 items-center justify-center rounded-full text-[7px] font-bold text-white"
          style={{ background: avatarColor(target.identifier) }}
        >
          {initials(target.identifier, label)}
        </span>
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}

function externalLinkProps(href: string) {
  return {
    href,
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      let url: URL;
      try {
        url = new URL(href);
      } catch {
        return;
      }
      if (!ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol)) return;
      openExternalUrl(url.href).catch(logAndIgnore);
    },
  };
}

function textContent(nodes: DOMNode[]): string {
  return nodes
    .map((node) => {
      if (node instanceof Text) return node.data;
      if (node instanceof Element) return textContent(node.children as DOMNode[]);
      return "";
    })
    .join("");
}

export function RichMessageContent({
  body,
  formattedBody,
  currentUserId,
  className,
  onUserPillClick,
  onRoomPillClick,
}: RichMessageContentProps) {
  const jumboEmojiSize = useAtomValue(jumboEmojiSizeAtom);
  const sanitizedFormattedBody = useMemo(
    () => (formattedBody ? sanitizeMatrixHtml(formattedBody) : null),
    [formattedBody],
  );
  const renderedText = useMemo(() => {
    if (!sanitizedFormattedBody) return body;
    return (
      new DOMParser().parseFromString(sanitizedFormattedBody, "text/html").body.textContent ?? ""
    );
  }, [body, sanitizedFormattedBody]);
  const jumbo = jumboEmojiSize !== "off" && isOnlyEmoji(renderedText);
  const content = useMemo(() => {
    if (!sanitizedFormattedBody) {
      return (
        <Linkify
          options={{
            attributes: { rel: "noreferrer" },
            // oxlint-disable-next-line react/no-unstable-nested-components -- Linkify's documented render hook is a callback, not a mounted component; this memoized options object is recreated only when message content changes.
            render: ({ attributes, content: linkContent }) => {
              const href = String(attributes.href ?? "");
              return (
                <a {...externalLinkProps(href)} className="underline">
                  {linkContent}
                </a>
              );
            },
          }}
        >
          {highlightRoomMentions(body)}
        </Linkify>
      );
    }

    const options: HTMLReactParserOptions = {
      // oxlint-disable-next-line react/no-unstable-nested-components -- html-react-parser requires a per-render replacement hook so it can close over the current user and pill navigation callbacks.
      replace(domNode) {
        if (domNode instanceof Text) {
          const parentName = domNode.parent instanceof Element ? domNode.parent.name : "";
          if (parentName === "code" || parentName === "pre") return undefined;
          return highlightRoomMentions(domNode.data) as ReturnType<
            NonNullable<HTMLReactParserOptions["replace"]>
          >;
        }
        if (!(domNode instanceof Element)) return undefined;

        const children = domNode.children as DOMNode[];
        if (domNode.attribs["data-mx-spoiler"] !== undefined) {
          return (
            <Spoiler reason={domNode.attribs["data-mx-spoiler"] || undefined}>
              {domToReact(children, options)}
            </Spoiler>
          );
        }

        const tex = domNode.attribs["data-mx-maths"];
        if (tex !== undefined) {
          return (
            <MathContent tex={tex || textContent(children)} display={domNode.name === "div"} />
          );
        }

        if (domNode.name === "pre") {
          const codeNode = children.find(
            (child): child is Element => child instanceof Element && child.name === "code",
          );
          const languageClass = codeNode?.attribs.class ?? "";
          const language = languageClass.match(/(?:^|\s)language-([\w-]+)/)?.[1] ?? null;
          return (
            <CodeBlock
              code={textContent((codeNode?.children as DOMNode[]) ?? children)}
              language={language}
            />
          );
        }

        if (domNode.name === "table") {
          return (
            <div className="my-2 max-w-full overflow-x-auto">
              <table className="w-max min-w-full border-collapse text-sm">
                {domToReact(children, options)}
              </table>
            </div>
          );
        }

        if (domNode.name === "th" || domNode.name === "td") {
          const Component = domNode.name;
          return (
            <Component
              {...attributesToProps(domNode.attribs, domNode.name)}
              className={cn(
                "border border-border px-2 py-1 text-left align-top",
                domNode.name === "th" && "bg-muted font-semibold",
              )}
            >
              {domToReact(children, options)}
            </Component>
          );
        }

        if (domNode.name === "a") {
          const target =
            domNode.attribs["data-mx-pill"] !== undefined
              ? parseMatrixPillTarget(domNode.attribs.href)
              : null;
          if (target) {
            return (
              <MatrixPill
                target={target}
                label={textContent(children) || target.identifier}
                currentUserId={currentUserId}
                onUserPillClick={onUserPillClick}
                onRoomPillClick={onRoomPillClick}
              />
            );
          }
          const href = domNode.attribs.href;
          if (href && /^(https?|mailto|tel):/i.test(href)) {
            return (
              <a
                {...attributesToProps(domNode.attribs, domNode.name)}
                {...externalLinkProps(href)}
                className="underline"
                rel="noreferrer"
              >
                {domToReact(children, options)}
              </a>
            );
          }
          return <span>{domToReact(children, options)}</span>;
        }
        return undefined;
      },
    };

    return parse(sanitizedFormattedBody, options);
  }, [body, currentUserId, onRoomPillClick, onUserPillClick, sanitizedFormattedBody]);

  return (
    <div
      className={cn(
        "rich-message min-w-0 break-words [&_blockquote]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_code]:rounded [&_code]:bg-black/10 [&_code]:px-1 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5",
        jumbo && jumboEmojiSize === "sm" && "text-2xl leading-tight",
        jumbo && jumboEmojiSize === "md" && "text-3xl leading-tight",
        jumbo && jumboEmojiSize === "lg" && "text-4xl leading-tight",
        className,
      )}
      data-jumbo-emoji={jumbo || undefined}
    >
      {content}
    </div>
  );
}

export function UndecryptedMessage() {
  return (
    <output
      aria-label="Decrypting message"
      className="flex w-44 max-w-full animate-pulse flex-col gap-1.5 py-1"
    >
      <span className="h-3 w-full rounded bg-muted" />
      <span className="h-3 w-2/3 rounded bg-muted" />
      <span className="sr-only">Decrypting message…</span>
    </output>
  );
}
