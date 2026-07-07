# Security Policy

Charm is a Matrix client that handles end-to-end encrypted (E2EE) conversations and
key material. Please report security issues responsibly.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Preferred: use [GitHub's private vulnerability reporting](https://github.com/CloudHub-Social/Charm/security/advisories/new)
for this repository, which opens a private advisory visible only to maintainers.

Alternatively, email **evie@gauthier.id** with details. Include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, or a proof of concept if available.
- The affected version/commit.

You should expect an initial response within a few days. Once a fix is available,
we'll coordinate disclosure timing with you before any public writeup.

## Scope

This covers the Charm client itself (frontend, Tauri IPC layer, and Rust backend
in this repository). Vulnerabilities in the Matrix protocol, `matrix-rust-sdk`, or
homeserver implementations should be reported to those projects directly.

## Supported versions

Charm 2.0 is under active pre-release development; only the latest `main` build is
supported. There is no separate long-term-support branch yet.
