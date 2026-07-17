---
default: patch
---

Fix an N+1 request storm on room load: redact-permission checks now fetch once per room instead of once per unique message sender.
