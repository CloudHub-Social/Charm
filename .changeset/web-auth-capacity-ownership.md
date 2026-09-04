---
"charm": patch
---

Track authentication permit lifetimes separately from cancellation records so abandoned setup attempts cannot reserve bounded replacement waits at saturation.

Retain a live owner's handoff witness through permit acquisition and publication so a newer replacement cannot be rejected in the handoff gap.

Release the semaphore slot before dropping its ownership witness to preserve the same guarantee during teardown.
