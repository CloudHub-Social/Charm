---
"charm": patch
---

Order native password-reset cancellation atomically against password-change dispatch, and report when cancellation can no longer prevent a password change.

Retain bounded completion status so late cancellation cannot report that it prevented an already-completed password change.

Wait for cancellation before dismissing recovery. If cancellation cannot be confirmed, clear sensitive inputs and explicitly warn that the password may still change.
