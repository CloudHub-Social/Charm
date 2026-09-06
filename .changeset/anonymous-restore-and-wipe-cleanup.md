---
default: patch
---

Stop anonymous web socket reconnect loops after an empty restore, and continue physical local-data deletion even when the preceding sign-out cleanup reports an error.
