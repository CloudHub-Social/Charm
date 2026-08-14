---
"charm": patch
---

Keep room-upgrade cleanup isolated across account changes, honor the persisted
kill switch immediately before upgrading, and block nested-space creation on
an unresolved or upgraded parent.
