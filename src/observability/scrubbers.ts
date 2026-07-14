const MATRIX_ID_PATTERN = /([!@#$])[^ \t\r\n"'<>]+:[A-Za-z0-9.-]+(?::\d+)?/g;
const MXC_URI_PATTERN = /mxc:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~-]+/g;
// Matrix event IDs in room versions that use the newer "opaque hash" format
// (MSC4192 / room v11+) have no `:server` suffix, so MATRIX_ID_PATTERN above
// (which requires one) doesn't catch them — e.g. an error like
// `event $AbCdEf0123456789... is not an m.room.message`. Length-gated at 10+
// chars after the sigil to avoid false-positiving on something like a `$100`
// price appearing incidentally in unrelated text; real event IDs are much
// longer (typically 43-char base64). Only `$` (event ID) gets a colonless
// variant — `!`/`@`/`#` (room/user/alias) IDs are conventionally always
// `:server`-suffixed, so widening those would mostly just add false
// positives.
const COLONLESS_EVENT_ID_PATTERN = /\$[A-Za-z0-9_-]{10,}/g;
// Plain `http(s)://` URLs — homeserver URLs in particular, which matrix-sdk
// formats into its own error types verbatim (e.g. a discovery or sync
// failure's Display output) and which neither MATRIX_ID_PATTERN nor
// MXC_URI_PATTERN catches. Mirrors the Rust side's `URL_PATTERN` in
// `src-tauri/src/observability_scrub.rs` — keep the two in sync. Deliberately
// broad (any http(s) URL) since a false positive just redacts a harmless URL,
// while a false negative leaks a self-hosted homeserver's address.
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;
// The value branch matches, in order:
//  1. a fully-quoted string — allowing a backslash-escaped quote inside
//     (`(?:[^"\\]|\\.)*`) so a JSON-ish escaped quote in the middle of a
//     secret (`password="abc\"tail"`) doesn't get treated as the closing
//     quote, leaking the rest (`tail"`);
//  2. a fully bracket/brace-wrapped value (`access_token=[abc]`,
//     `password={abc}` — some Debug/serde formatters render a value this
//     way), matched and replaced as a balanced pair so it doesn't fall
//     through to the unquoted branch below (which excludes `[`/`{` and so
//     wouldn't even start matching at the opening bracket);
//  3. an unquoted run of non-delimiter characters — excluding `[`/`{` (in
//     addition to `]`/`}`) so this branch never *starts* inside something
//     that should have been matched as a bracket-wrapped value by branch 2,
//     nor partially consumes into one;
//  4/5. falling back when none of the above matched: an *unterminated*
//     quoted or bracket-wrapped value (an opening delimiter with no closing
//     one, e.g. a diagnostic string truncated mid-value like
//     `access_token="abc123` or `access_token=[abc`). Without that
//     fallback, an unterminated value matches neither its balanced branch
//     (no closing delimiter) nor the unquoted branch (the leading quote/
//     bracket isn't a valid unquoted char), and slips through unredacted.
// The field-name alternation ends with `[A-Za-z0-9]*secret` — a generic
// catch-all for any field whose name simply *ends* in "secret"
// (`client_secret`, `sharedSecret`, `shared_secret`, ...), mirroring
// SECRET_FIELD_NAME_PATTERN below's `|secret)$` suffix. Without it, a
// generic `*secret` field wasn't in the explicit list here (only the more
// specific access_token/password/etc. names were), so a plain-text IPC
// error like `client_secret=abc123` would reach summarizeErrorText's
// scrubbed-but-kept captured-exception text unredacted, even though the
// exact same field name on an object would already be redacted via
// SECRET_FIELD_NAME_PATTERN.
const SECRET_FIELD_PATTERN =
  /((?:access_token|accessToken|refresh_token|refreshToken|password|passphrase|recovery_key|recoveryKey|secret_storage_key|secretStorageKey|session_key|sessionKey|[A-Za-z0-9]*secret)["']?\s*[:=]\s*)(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\[((?:[^\]\\]|\\.)*)\]|\{((?:[^}\\]|\\.)*)\}|([^"'\s,{}[\]]+)|"((?:[^"\\]|\\.)*)|'((?:[^'\\]|\\.)*)|\[((?:[^\]\\]|\\.)*)|\{((?:[^}\\]|\\.)*))/gi;
// Suffix-matched (rather than exact) and case-insensitive so a field name
// like `newPassword` or `oldPassword` redacts the same as `password`, and
// camelCase names (`recoveryKey`, `accessToken`) redact the same as their
// snake_case equivalents. SECRET_FIELD_PATTERN above mirrors this list (plus
// a generic `*secret` catch-all) for the free-text `key=value` case.
const SECRET_FIELD_NAME_PATTERN =
  /(?:access[_-]?token|refresh[_-]?token|password|passphrase|recovery[_-]?key|secret[_-]?storage[_-]?key|session[_-]?key|secret)$/i;

export function scrubMatrixIds(text: string): string {
  return text
    .replace(MXC_URI_PATTERN, "mxc://[redacted]/[redacted]")
    .replace(MATRIX_ID_PATTERN, "$1[redacted]:[redacted]")
    .replace(COLONLESS_EVENT_ID_PATTERN, "$[redacted]");
}

/**
 * Redacts plain `http(s)://` URLs (e.g. homeserver addresses), preserving
 * only the scheme. Runs after `scrubMatrixIds` so an already-redacted
 * `mxc://[redacted]/[redacted]` (a different, non-`http(s)` scheme) is left
 * untouched by this pass.
 *
 * Deliberately NOT part of `scrubSensitiveText`/`scrubSentryValue` (the
 * generic scrubber used on whole Sentry events, breadcrumbs, spans, and
 * logs via `instrument.ts`'s `beforeSend*` hooks): those payloads include
 * stack-trace frame fields (`filename`, `abs_path`) that are themselves
 * `https://` URLs to JS asset bundles, and blanket-redacting those would
 * strip the file context Sentry needs for source-map symbolication on every
 * captured exception, not just IPC ones. Used only by
 * `summarizeErrorText`, the IPC-error-specific path where a
 * matrix-sdk error's embedded homeserver URL is the actual thing being
 * guarded against.
 */
export function scrubUrls(text: string): string {
  return text.replace(URL_PATTERN, (match) =>
    match.toLowerCase().startsWith("https://") ? "https://[redacted]" : "http://[redacted]",
  );
}

export function scrubSecrets(text: string): string {
  return text.replace(
    SECRET_FIELD_PATTERN,
    (
      _match,
      prefix: string,
      doubleQuoted?: string,
      singleQuoted?: string,
      _bracketed?: string,
      _braced?: string,
      _unquoted?: string,
      unterminatedDoubleQuoted?: string,
      unterminatedSingleQuoted?: string,
    ) => {
      if (doubleQuoted !== undefined) return `${prefix}"[redacted]"`;
      if (singleQuoted !== undefined) return `${prefix}'[redacted]'`;
      if (unterminatedDoubleQuoted !== undefined) return `${prefix}"[redacted]`;
      if (unterminatedSingleQuoted !== undefined) return `${prefix}'[redacted]`;
      // Bracket/brace-wrapped values (both balanced and unterminated) fall
      // through to the same bare `[redacted]` placeholder as an unquoted
      // value — not wrapped in an extra outer `[`/`{` the way quoted values
      // keep their quote marks, since e.g. `[[redacted]]` reads like a
      // formatting bug rather than a clean redaction.
      return `${prefix}[redacted]`;
    },
  );
}

export function scrubSensitiveText(text: string): string {
  return scrubSecrets(scrubMatrixIds(text));
}

export function scrubSentryValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === "string") return scrubSensitiveText(value) as T;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => scrubSentryValue(item, seen)) as T;
  }

  const output: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_FIELD_NAME_PATTERN.test(key)
      ? "[redacted]"
      : scrubSentryValue(fieldValue, seen);
  }
  return output as T;
}

// Free-form value fields (message bodies, captions, file paths) are summarized
// to a bare length below — see `summarizeString`'s doc comment for why. Error
// text is different: it's diagnostic, not user content, so we keep the
// scrubbed text itself (Matrix IDs/secrets already stripped) rather than
// discarding it to a length tag, capped so a pathological error can't blow up
// payload size.
const MAX_SUMMARIZED_ERROR_LENGTH = 300;

export function summarizeErrorText(value: string): string {
  // Includes `scrubUrls` (unlike `scrubSensitiveText`) — see that function's
  // doc comment for why URL redaction is scoped to this diagnostic-text path
  // rather than the generic Sentry-event scrubber.
  //
  // `scrubSecrets` runs *before* `scrubUrls` (unlike scrubUrls's own doc
  // comment, which describes running after `scrubMatrixIds` — that ordering
  // is unaffected). If URLs were scrubbed first, a secret field whose value
  // is itself a URL (`access_token=https://example.com`) would already be
  // `access_token=https://[redacted]` by the time `scrubSecrets` runs; its
  // unquoted-value branch (which excludes `[`) would then only capture
  // `https://` and leave the `[redacted]` placeholder's own `[`/`]`
  // characters as unmatched literal text, producing a doubled
  // `access_token=[redacted][redacted]`. Scrubbing secrets first means the
  // whole URL is captured and replaced in one match.
  const scrubbed = scrubUrls(scrubSecrets(scrubMatrixIds(value)));
  if (scrubbed.length <= MAX_SUMMARIZED_ERROR_LENGTH) return scrubbed;
  return `${scrubbed.slice(0, MAX_SUMMARIZED_ERROR_LENGTH)}…[truncated, full length ${scrubbed.length}]`;
}

/**
 * Summarizes a string for breadcrumb/exception *value* fields (message
 * bodies, captions, file paths, etc.) instead of copying it verbatim:
 * `scrubSensitiveText` only recognizes specific shapes (a Matrix ID with a
 * `:server` suffix or a long-enough colonless event ID, a `key=value`/
 * `key: value` secret pattern), so any string that doesn't happen to match
 * one of those — an ordinary message body, a caption, a local file path, a
 * room topic — would otherwise be stored as-is. Returning a length-only (or
 * scrubbed-and-then-length-tagged)
 * placeholder means no free-text or PII-shaped value is ever recorded raw,
 * regardless of whether we've anticipated its field name or shape.
 *
 * Error text goes through `summarizeErrorText` instead, which keeps the
 * scrubbed content — diagnostic error strings are what actually make a
 * captured exception useful, and they're far less likely to carry the kind of
 * free-form user content this function is guarding against.
 */
export function summarizeString(value: string): string {
  const scrubbed = scrubSensitiveText(value);
  if (scrubbed !== value) return `[redacted-string:${value.length}]`;
  return `[string:${value.length}]`;
}

/**
 * Recursively summarizes a value the same way: secret-shaped keys are
 * redacted outright, strings are length-summarized (see `summarizeString`),
 * and nested objects beyond one level deep collapse to their key list rather
 * than being walked further, bounding how much structure — and therefore how
 * much potential content — ends up in telemetry.
 */
export function summarizeValue(value: unknown, key?: string, depth = 0): unknown {
  if (key && SECRET_FIELD_NAME_PATTERN.test(key)) {
    return "[redacted]";
  }
  if (typeof value === "string") return summarizeString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "undefined") return "[undefined]";
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (typeof value !== "object") return `[${typeof value}]`;
  // eslint-disable-next-line unicorn/no-array-sort -- `toSorted()` is not available in supported older WebViews.
  if (depth >= 1) return { type: "object", keys: Object.keys(value).sort() };

  const output: Record<string, unknown> = {};
  for (const [fieldKey, fieldValue] of Object.entries(value as Record<string, unknown>)) {
    output[fieldKey] = summarizeValue(fieldValue, fieldKey, depth + 1);
  }
  return output;
}
