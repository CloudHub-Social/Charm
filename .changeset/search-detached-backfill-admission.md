---
default: patch
---

Prevent delayed search backfills from recreating stale pending state after renderer reload, and protect all backfill exits from clearing a replacement scan.
