/**
 * Anonymized per-install identifier used as the OFREP targeting key, so GO
 * Feature Flag can bucket this install deterministically for percentage
 * rollouts. It is random, non-reversible, generated locally, and **never** the
 * Matrix ID / email / display name — see `PRIVACY.md`. Independent of Spec 21's
 * Sentry ID so cohorting works regardless of observability consent.
 */
const INSTALL_ID_STORAGE_KEY = "charm:featureFlagsInstallId";

function generateInstallId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Last resort (no Web Crypto): non-cryptographic, still only a bucketing key.
  return `fallback-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// Holds the id for the session when localStorage is unavailable (blocked
// storage / private mode / quota), so a client whose storage throws doesn't
// regenerate a new targeting key on every refresh and rebucket itself.
let sessionFallbackId: string | undefined;

/** Returns the stable per-install ID, generating and persisting one on first use. */
export function getInstallId(): string {
  if (sessionFallbackId) return sessionFallbackId;
  try {
    const existing = localStorage.getItem(INSTALL_ID_STORAGE_KEY);
    if (existing) return existing;
  } catch {
    // localStorage unavailable — fall through to a session-stable ephemeral id.
  }
  const id = generateInstallId();
  try {
    localStorage.setItem(INSTALL_ID_STORAGE_KEY, id);
  } catch {
    // Persistence blocked — keep a stable id for this session so cohorting
    // doesn't rebucket on every refresh.
    sessionFallbackId = id;
  }
  return id;
}
