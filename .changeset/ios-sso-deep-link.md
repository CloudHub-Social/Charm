---
default: patch
---

Fix iOS launch and Safari single-sign-on callbacks when building with Xcode 27,
including a post-login database failure caused by continuing to use the
temporary Matrix store after it was moved into the signed-in account, and
register Tao's scene delegate before UIKit resolves the static scene manifest.
Heap-box release-mode Tauri IPC futures so large Matrix startup commands do not
overflow the iOS main-thread stack after login. Stop the Xcode phase immediately
when Rust compilation fails instead of repairing and linking a stale archive.
