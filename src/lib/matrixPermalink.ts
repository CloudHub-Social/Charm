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

/** Build the canonical matrix.to permalink for one event in a room. */
export function eventPermalink(roomId: string, eventId: string): string {
  return `https://matrix.to/#/${encodeRfc3986Component(roomId)}/${encodeRfc3986Component(eventId)}`;
}
