/**
 * The MSC4108 check code is a single byte (0-255 in principle, but
 * `CheckCode::to_digit()` on the Rust side only ever produces 0-99) shown as
 * a short decimal string on both devices. Pure and Tauri-context-free by
 * design so it can be unit tested without mocking `invoke` — mirrors
 * `roomDisplay.ts`/`deepLink.ts`'s split of parsing logic out of the
 * component that uses it.
 */

/** Strips non-digit input and caps length, for use as an <input> onChange filter. */
export function sanitizeCheckCodeInput(value: string): string {
  return value.replace(/\D/g, "").slice(0, 2);
}

/** Parses a sanitized check-code string into a submittable digit, or null if invalid. */
export function parseCheckCode(value: string): number | null {
  if (value === "") return null;
  const code = Number.parseInt(value, 10);
  if (Number.isNaN(code) || code < 0 || code > 99) return null;
  return code;
}
