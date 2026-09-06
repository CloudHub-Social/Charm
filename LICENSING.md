# Charm licensing

Charm's original source code and documentation are licensed under the
[Apache License, Version 2.0](LICENSE). The repository's package and crate
manifests use the SPDX identifier `Apache-2.0`.

At adoption, the recorded Git history through
`49d99363c999c499919ef9fdc6e74d50e68b64ec` identified Evie Gauthier as the
only human author; the remaining author identities were automated tools and
project bots. That is the project's provenance baseline, not a representation
that third-party components are original Charm work.

## What the license covers

Apache-2.0 applies only to material for which the Charm project has the right
to grant that license. Dependencies, fonts, generated artifacts, embedded
platform components, and other third-party material remain subject to their
own licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), the generated
`THIRD_PARTY_LICENSES.txt` included in distribution artifacts, the lockfiles,
and the signed SPDX SBOMs attached to releases.

The Apache license does not grant permission to use project or contributor
trade names, trademarks, service marks, or product names except as required
for reasonable and customary attribution.

## Contributions and generated code

Unless a contribution conspicuously says otherwise, intentionally submitted
contributions are licensed to the project under Apache-2.0 as described in
section 5 of the license. Contributors must have the right to submit their
work and must preserve or disclose any third-party terms that apply.

The use of an AI coding tool does not establish copyright ownership, erase
source-license obligations, or make copied material original. The person
submitting AI-assisted work remains responsible for reviewing it, confirming
its provenance, and removing material they cannot license to the project.

## Sable Call boundary

Sable Call is external software and is not part of Charm's Apache-2.0 work.
Charm may interoperate with a separately hosted Sable Call deployment through
the Matrix Widget API, but does not vendor, compile, package, cache for offline
use, or redistribute Sable Call. The complete architectural and release
boundary is documented in
[Licensing and external-widget boundaries](docs-site/src/content/docs/architecture/licensing-boundaries.md).

Changing that boundary requires a fresh licensing and distribution review.
