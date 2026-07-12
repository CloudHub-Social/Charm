const MATRIX_ID_PATTERN = /([!@#$])[^ \t\r\n"'<>]+:[A-Za-z0-9.-]+(?::\d+)?/g;
const MXC_URI_PATTERN = /mxc:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~-]+/g;
const SECRET_FIELD_PATTERN =
  /((?:access_token|accessToken|refresh_token|refreshToken|password|passphrase|recovery_key|recoveryKey|secret_storage_key|secretStorageKey|session_key|sessionKey)["']?\s*[:=]\s*["']?)([^"'\s,}\]]+)/gi;
// Suffix-matched (rather than exact) and case-insensitive so a field name
// like `newPassword` or `oldPassword` redacts the same as `password`, and
// camelCase names (`recoveryKey`, `accessToken`) redact the same as their
// snake_case equivalents — see observability/ipc.ts's SENSITIVE_KEY_PATTERN,
// which this mirrors.
const SECRET_FIELD_NAME_PATTERN =
  /(?:access[_-]?token|refresh[_-]?token|password|passphrase|recovery[_-]?key|secret[_-]?storage[_-]?key|session[_-]?key|secret)$/i;

export function scrubMatrixIds(text: string): string {
  return text
    .replace(MXC_URI_PATTERN, "mxc://[redacted]/[redacted]")
    .replace(MATRIX_ID_PATTERN, "$1[redacted]:[redacted]");
}

export function scrubSecrets(text: string): string {
  return text.replace(SECRET_FIELD_PATTERN, "$1[redacted]");
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
