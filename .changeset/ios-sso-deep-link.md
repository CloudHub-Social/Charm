---
default: patch
---

Fix iOS launch and Safari single-sign-on callbacks when building with Xcode 27,
including a post-login database failure caused by continuing to use the
temporary Matrix store after it was moved into the signed-in account.
