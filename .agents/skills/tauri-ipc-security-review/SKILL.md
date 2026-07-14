---
name: tauri-ipc-security-review
description: Review Charm's typed Tauri IPC boundary and capabilities for concrete security defects. Use when adding or changing Tauri commands, Rust command handlers, frontend invoke calls, filesystem or process access, deep links, URLs, serialization, or platform capabilities.
---

# Tauri IPC security review

Map each reviewed frontend call to its Rust command, input type, validation, capability grant, sensitive operation, return value, and error path.

Check:

- command registration and least-privilege allowlisting
- validation and normalization of paths, URLs, identifiers, sizes, and enums
- traversal, symlink, TOCTOU, scheme confusion, and origin confusion
- filesystem, process, shell, opener, network, and deep-link access
- serialization limits, numeric conversions, optional fields, and unsafe defaults
- authorization assumptions and frontend compromise impact
- returned secrets, identifiers, raw events, internal paths, and verbose errors
- races, cancellation, duplicate invocation, replay, and idempotency
- desktop, web, Android, and iOS differences
- Tauri capability and CSP scope

Trace data flow before judging a finding. Do not equate a dangerous API name with exploitability without a reachable path.

Report findings first, ordered by severity. For each finding include severity, confidence, exact file and line, source-to-sink path, exploit preconditions, impact, evidence, smallest remediation, and a regression test. Separate confirmed findings, defense-in-depth improvements, and unresolved questions. State explicitly when no actionable finding is present.
