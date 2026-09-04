---
"charm": patch
---

Serialize ignored-user changes across settings, slash commands, and web sessions in one backend process, fetching current server data so concurrent updates do not overwrite recent blocks from a stale sync cache.

Invalidate the settings ignored-user query after successful ignore/unignore slash commands.
