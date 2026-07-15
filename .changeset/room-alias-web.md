---
default: patch
---

Add web companion server routes for room alias management (list/check/add/remove local aliases, set/clear canonical alias, remove alt alias), wiring the `charm-web-server` transport to the same `_impl` functions desktop's Spec 32 already uses behind the `room_alias_management` flag.
