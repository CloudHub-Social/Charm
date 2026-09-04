---
default: patch
---

Reject and attempt to revoke newly committed login sessions when final persistence cleanup fails, preventing silent restoration or resumption of a superseded client and reporting incomplete cleanup explicitly.
