# Third-party notices

Charm is built with third-party packages and platform components. Those works
are not relicensed under Charm's Apache-2.0 license. Their own license files
and notices control.

The lockfiles are the canonical dependency inventory for a source revision.
Distribution builds generate `THIRD_PARTY_LICENSES.txt` from the installed pnpm
graph and Cargo's locked external-crate graph. That file reproduces the resolved
packages' available license, notice, copying, and copyright files and is
included in web, Tauri, documentation-site, and companion-server artifacts.
When a split package omits a standalone file, generation uses a same-repository
license file or supported canonical license text with that package's attribution.
It fails when none of those sources can resolve the declared license.
Android builds additionally embed AboutLibraries metadata generated from the
resolved Gradle variant. The build fails if a Maven artifact has no license or
uses a license outside Charm's reviewed permissive allowlist.

Each published release also includes signed, platform-named SPDX JSON software
bills of materials. As the README explains, those SBOMs describe the
lockfile-pinned source revision and complement rather than replace the bundled
license texts.

Representative directly bundled frontend dependencies include:

| Component                                | License declared by its package metadata |
| ---------------------------------------- | ---------------------------------------- |
| React and React DOM                      | MIT                                      |
| DOMPurify                                | MPL-2.0 OR Apache-2.0                    |
| Tiptap                                   | MIT                                      |
| Radix UI                                 | MIT                                      |
| Sentry JavaScript SDK                    | MIT                                      |
| JetBrains Mono and Manrope font packages | OFL-1.1                                  |
| Gradle wrapper scripts and pinned JAR    | Apache-2.0                               |

This short table is an attribution index, not a replacement for the lockfiles,
generated `THIRD_PARTY_LICENSES.txt`, or release SBOMs.

Canonical fallback texts stored under `scripts/license-texts/` come from the
[SPDX MPL-2.0 text](https://spdx.org/licenses/MPL-2.0) and the Free Software
Foundation's [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html) and
[LGPLv3](https://www.gnu.org/licenses/lgpl-3.0.html) publications. They cover
resolved packages that declare those licenses but omit the terms from a split
platform package; package-provided terms remain preferred.

Opaque executable and archive formats are rejected from release source
archives unless their provenance has been reviewed and their exact SHA-256 is
pinned by `license:check`. The Gradle wrapper JAR is the sole current exception.

## External software: Sable Call

Sable Call is not bundled with or redistributed by Charm. The planned
integration loads a separately hosted Matrix widget over HTTPS and communicates
through a scoped Widget API bridge.

The licensing review used the following immutable upstream revision:

- Repository: <https://github.com/SableClient/SableCall>
- Revision: `a93dd8b410b18502b62f1149ee382e2582393649`
- License file: [GNU Affero General Public License v3.0](https://github.com/SableClient/SableCall/blob/a93dd8b410b18502b62f1149ee382e2582393649/LICENSE-AGPL-3.0)
- Additional terms: [commercial license notice](https://github.com/SableClient/SableCall/blob/a93dd8b410b18502b62f1149ee382e2582393649/LICENSE-COMMERCIAL)
- Upstream notices: [THIRD_PARTY_NOTICES](https://github.com/SableClient/SableCall/blob/a93dd8b410b18502b62f1149ee382e2582393649/THIRD_PARTY_NOTICES)

The commercial notice refers to a valid Element commercial license. It does
not, by itself, establish rights to every Sable-specific modification. Charm
therefore relies only on the external-service boundary unless separate rights
covering the exact distributed work are confirmed.
