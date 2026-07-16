/**
 * Percent-encode one matrix.to path component according to RFC 3986.
 * `encodeURIComponent` deliberately leaves `!'()*` unescaped, so encode
 * those characters as well to match the Matrix specification's requirement
 * that identifiers and event ids be fully percent-encoded.
 */
function encodeRfc3986Component(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Return the server-name portion of a Matrix user id, including any port. */
export function userIdServerName(userId: string): string | null {
  const separator = userId.indexOf(":");
  if (!userId.startsWith("@") || separator < 2 || separator === userId.length - 1) return null;
  return userId.slice(separator + 1);
}

/** Build a routable matrix.to permalink for one event in a room. */
export function eventPermalink(roomId: string, eventId: string, viaServer: string): string {
  return `https://matrix.to/#/${encodeRfc3986Component(roomId)}/${encodeRfc3986Component(eventId)}?via=${encodeRfc3986Component(viaServer)}`;
}
