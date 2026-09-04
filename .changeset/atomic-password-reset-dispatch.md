---
"charm": patch
---

Order native password-reset cancellation atomically against password-change dispatch, and report when cancellation can no longer prevent a password change.

Retain bounded completion status so late cancellation cannot report that it prevented an already-completed password change.
