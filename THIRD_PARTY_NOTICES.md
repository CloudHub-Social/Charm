# Third-party notices

Charm is built with third-party packages and platform components. Those works
are not relicensed under Charm's Apache-2.0 license. Their own license files
and notices control.

The lockfiles are the canonical dependency inventory for a source revision.
Each published release also includes signed, platform-named SPDX JSON software
bills of materials. As the README explains, those SBOMs describe the
lockfile-pinned source revision and are not yet an exhaustive inventory of
every packaged binary or platform-resolved transitive dependency. Completing
and reviewing that inventory is a release gate, not a claim made by this file.

Representative directly bundled frontend dependencies include:

| Component                                | License declared by its package metadata |
| ---------------------------------------- | ---------------------------------------- |
| React and React DOM                      | MIT                                      |
| DOMPurify                                | MPL-2.0 OR Apache-2.0                    |
| Tiptap                                   | MIT                                      |
| Radix UI                                 | MIT                                      |
| Sentry JavaScript SDK                    | MIT                                      |
| JetBrains Mono and Manrope font packages | OFL-1.1                                  |
| Gradle wrapper scripts                   | Apache-2.0                               |

This short table is an attribution index, not a replacement for the lockfiles,
license texts, or release SBOMs.

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
