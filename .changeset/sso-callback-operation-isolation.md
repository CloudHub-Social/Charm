---
"charm": patch
---

Wait for native SSO completion and cancellation to settle before allowing restart, preserving successful sign-in when durable adoption wins the cancellation race. Ignore obsolete errors and callback updates after leaving the login screen.
