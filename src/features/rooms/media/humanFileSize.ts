/**
 * Formats a byte count as a human-readable size (`"1.2 MB"`, `"340 KB"`),
 * matching common OS file-manager conventions (binary/1024-based units,
 * `KB`/`MB`/`GB` labels rather than `KiB`/`MiB`/`GiB`).
 */
export function humanFileSize(bytes: number | null | undefined): string {
  if (bytes == null || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${units[unitIndex]}`;
}
