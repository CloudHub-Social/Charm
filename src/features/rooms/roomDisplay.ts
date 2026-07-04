const AVATAR_COLORS = [
  "var(--color-accent)",
  "var(--color-warning)",
  "var(--color-success)",
  "var(--color-danger)",
  "var(--gray-500)",
];

function hash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) - h + input.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

export function displayName(roomId: string, name: string | null): string {
  return name ?? roomId;
}

export function initials(roomId: string, name: string | null): string {
  const label = displayName(roomId, name).replace(/^[#@]/, "");
  return label.slice(0, 2).toUpperCase();
}

export function avatarColor(roomId: string): string {
  return AVATAR_COLORS[hash(roomId) % AVATAR_COLORS.length];
}
