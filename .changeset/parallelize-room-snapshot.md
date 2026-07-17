---
default: patch
---

Parallelize the room-list snapshot loop (bounded concurrency) and cache feature-flag reads, cutting login and steady-state sync latency for accounts with many rooms.
