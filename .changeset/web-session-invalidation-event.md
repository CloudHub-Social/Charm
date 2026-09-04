---
"charm": patch
---

Emit the session-invalidation event to connected browser tabs when the web companion permanently removes their session, before fallible disk cleanup.

Invalidate on authenticated HTTP 401s and probe closed sockets for missed revocation, while preserving sessions on network failures and ignoring stale responses after replacement login.
