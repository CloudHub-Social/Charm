# Graph Report - Charm (2026-07-05)

## Corpus Check

- 105 files · ~68,395 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary

- 715 nodes · 1135 edges · 77 communities (60 shown, 17 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 12 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness

- Built from commit: `8d0dd7f4`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)

- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]

## God Nodes (most connected - your core abstractions)

1. `cn()` - 46 edges
2. `MatrixState` - 30 edges
3. `scripts` - 18 edges
4. `compilerOptions` - 17 edges
5. `restore_oauth_session()` - 12 edges
6. `try_restore_session()` - 11 edges
7. `register()` - 11 edges
8. `login()` - 10 edges
9. `build_client()` - 10 edges
10. `complete_sso_login()` - 10 edges

## Surprising Connections (you probably didn't know these)

- `RustPlugin` --references--> `project` [EXTRACTED]
  src-tauri/gen/android/buildSrc/src/main/java/social/cloudhub/charm/kotlin/RustPlugin.kt → knip.json
- `discover_rejects_an_unreachable_server()` --calls--> `discover()` [INFERRED]
  src-tauri/tests/discovery_and_registration.rs → src-tauri/src/matrix/mod.rs
- `discover_resolves_a_plain_homeserver_url()` --calls--> `discover()` [INFERRED]
  src-tauri/tests/discovery_and_registration.rs → src-tauri/src/matrix/mod.rs
- `register_with_dummy_auth_creates_a_working_session()` --calls--> `register_with_dummy_auth()` [INFERRED]
  src-tauri/tests/discovery_and_registration.rs → src-tauri/src/matrix/mod.rs
- `resolve_alias_rejects_a_malformed_alias()` --calls--> `resolve_alias()` [INFERRED]
  src-tauri/tests/alias_resolution.rs → src-tauri/src/matrix/mod.rs

## Import Cycles

- None detected.

## Communities (77 total, 17 thin omitted)

### Community 0 - "Community 0"

Cohesion: 0.07
Nodes (82): AppHandle, CheckCodeSender, Client, ClientMetadata, Emoji, JoinHandle, build_client(), cancel_sso_login() (+74 more)

### Community 1 - "Community 1"

Cohesion: 0.05
Nodes (53): LoginScreen(), DiscoveryStatus, useHomeserverDiscovery(), acceptVerificationRequest(), cancelVerification(), confirmSasVerification(), CrossSigningStatusSummary, discoverHomeserver() (+45 more)

### Community 2 - "Community 2"

Cohesion: 0.05
Nodes (41): ignore, ignoreDependencies, project, rules, enumMembers, exports, types, $schema (+33 more)

### Community 3 - "Community 3"

Cohesion: 0.05
Nodes (42): dependencies, class-variance-authority, clsx, @fontsource/jetbrains-mono, @fontsource/manrope, jotai, lucide-react, qrcode (+34 more)

### Community 4 - "Community 4"

Cohesion: 0.07
Nodes (26): MainActivity, app, security, windows, build, beforeBuildCommand, beforeDevCommand, devUrl (+18 more)

### Community 5 - "Community 5"

Cohesion: 0.17
Nodes (18): clear_session(), dummy_oauth_session(), dummy_session(), get_or_create_passphrase(), load_session(), oauth_session_round_trips_through_keychain(), passphrase_is_stable_across_calls(), save_oauth_session() (+10 more)

### Community 6 - "Community 6"

Cohesion: 0.10
Nodes (20): compilerOptions, allowImportingTsExtensions, isolatedModules, jsx, lib, module, moduleResolution, noEmit (+12 more)

### Community 7 - "Community 7"

Cohesion: 0.11
Nodes (17): aliases, components, hooks, lib, ui, utils, iconLibrary, rsc (+9 more)

### Community 8 - "Community 8"

Cohesion: 0.18
Nodes (10): cn(), DropdownMenuCheckboxItem(), DropdownMenuContent(), DropdownMenuItem(), DropdownMenuLabel(), DropdownMenuRadioItem(), DropdownMenuSeparator(), DropdownMenuShortcut() (+2 more)

### Community 9 - "Community 9"

Cohesion: 0.17
Nodes (14): LoginScreenProps, Mode, QrLoginScreenProps, cancelSsoLogin(), completeSsoLogin(), login(), LoginResponse, register() (+6 more)

### Community 10 - "Community 10"

Cohesion: 0.19
Nodes (11): parseCheckCode(), sanitizeCheckCodeInput(), QrLoginScreen(), Stage, cancelQrLogin, startQrLogin, cancelQrLogin(), onQrLoginProgress() (+3 more)

### Community 11 - "Community 11"

Cohesion: 0.13
Nodes (14): anyOf, anyOf, description, definitions, Application, Target, Value, description (+6 more)

### Community 12 - "Community 12"

Cohesion: 0.13
Nodes (14): anyOf, anyOf, description, definitions, Application, Target, Value, description (+6 more)

### Community 13 - "Community 13"

Cohesion: 0.16
Nodes (8): Button(), buttonVariants, DialogContent(), DialogDescription(), DialogFooter(), DialogHeader(), DialogOverlay(), DialogTitle()

### Community 14 - "Community 14"

Cohesion: 0.24
Nodes (7): Input(), Default, Disabled, Invalid, Story, WithLabel, Label()

### Community 15 - "Community 15"

Cohesion: 0.20
Nodes (9): Charm 2.0 – Agent Instructions, Dependency Changes, Destructive Actions, Git & Branching, graphify, Matrix Spec Compliance, Merge Conflicts, Pull Requests (+1 more)

### Community 16 - "Community 16"

Cohesion: 0.29
Nodes (7): logged_in_client(), synced_client(), test_password(), test_username(), resolve_alias_rejects_a_malformed_alias(), resolve_alias_returns_the_room_id(), sas_verification_completes_with_matching_emojis()

### Community 17 - "Community 17"

Cohesion: 0.20
Nodes (10): $ref, description, items, type, uniqueItems, description, items, type (+2 more)

### Community 18 - "Community 18"

Cohesion: 0.20
Nodes (10): type, webviews, windows, items, description, items, type, description (+2 more)

### Community 19 - "Community 19"

Cohesion: 0.20
Nodes (10): $ref, description, items, type, uniqueItems, description, items, type (+2 more)

### Community 20 - "Community 20"

Cohesion: 0.20
Nodes (10): type, webviews, windows, items, description, items, type, description (+2 more)

### Community 21 - "Community 21"

Cohesion: 0.20
Nodes (9): AllVariants, Default, Destructive, Disabled, Ghost, Link, Outline, Secondary (+1 more)

### Community 22 - "Community 22"

Cohesion: 0.39
Nodes (5): parseRoomTarget(), watchDeepLinks(), tryRestoreSession(), RoomsScreen(), App()

### Community 23 - "Community 23"

Cohesion: 0.22
Nodes (9): properties, Identifier, description, oneOf, type, identifier, remote, anyOf (+1 more)

### Community 24 - "Community 24"

Cohesion: 0.22
Nodes (9): properties, Identifier, description, oneOf, type, identifier, remote, anyOf (+1 more)

### Community 25 - "Community 25"

Cohesion: 0.25
Nodes (8): description, properties, required, type, CapabilityRemote, urls, description, type

### Community 26 - "Community 26"

Cohesion: 0.25
Nodes (8): description, properties, required, type, CapabilityRemote, urls, description, type

### Community 27 - "Community 27"

Cohesion: 0.25
Nodes (7): compilerOptions, allowSyntheticDefaultImports, composite, module, moduleResolution, skipLibCheck, include

### Community 28 - "Community 28"

Cohesion: 0.25
Nodes (4): PopoverContent(), PopoverDescription(), PopoverHeader(), PopoverTitle()

### Community 29 - "Community 29"

Cohesion: 0.29
Nodes (6): Automated hooks, Branch and PR rules, Claude Code instructions for Charm (2.0), Code navigation (graphify), Identity — keep it clean, Quality gate

### Community 30 - "Community 30"

Cohesion: 0.48
Nodes (6): base_value_if_pr_create(), is_allowed(), main(), Return (is_gh_pr_create, base_value_or_None) for one simple command., split_simple_commands(), tokenize()

### Community 31 - "Community 31"

Cohesion: 0.29
Nodes (6): First run (generates config + signing keys into `./data`), Local dev homeserver, QR login (MSC4108) — separate MAS-delegated stack, Register a test user, Start, Stop

### Community 32 - "Community 32"

Cohesion: 0.47
Nodes (3): RoomMessageSummary, RoomTimelineUpdate, TimelinePage

### Community 33 - "Community 33"

Cohesion: 0.40
Nodes (3): Boolean, DefaultTask, BuildTask

### Community 34 - "Community 34"

Cohesion: 0.33
Nodes (5): description, identifier, permissions, $schema, windows

### Community 35 - "Community 35"

Cohesion: 0.40
Nodes (4): Charm, Identity — keep it clean, Planning / source of truth, Updater signing key

### Community 39 - "Community 39"

Cohesion: 0.50
Nodes (4): description, required, type, Capability

### Community 40 - "Community 40"

Cohesion: 0.50
Nodes (4): default, description, type, description

### Community 41 - "Community 41"

Cohesion: 0.50
Nodes (4): default, description, type, local

### Community 42 - "Community 42"

Cohesion: 0.50
Nodes (4): description, required, type, Capability

### Community 43 - "Community 43"

Cohesion: 0.50
Nodes (4): default, description, type, description

### Community 44 - "Community 44"

Cohesion: 0.50
Nodes (4): default, description, type, local

### Community 46 - "Community 46"

Cohesion: 0.67
Nodes (3): Number, anyOf, description

### Community 47 - "Community 47"

Cohesion: 0.67
Nodes (3): PermissionEntry, anyOf, description

### Community 48 - "Community 48"

Cohesion: 0.67
Nodes (3): Number, anyOf, description

### Community 49 - "Community 49"

Cohesion: 0.67
Nodes (3): PermissionEntry, anyOf, description

## Knowledge Gaps

- **292 isolated node(s):** `config`, `preview`, `$schema`, `style`, `rsc` (+287 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **17 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions

_Questions this graph is uniquely positioned to answer:_

- **Why does `Config` connect `Community 2` to `Community 0`?**
  _High betweenness centrality (0.105) - this node is a cross-community bridge._
- **What connects `Return (is_gh_pr_create, base_value_or_None) for one simple command.`, `config`, `preview` to the rest of the system?**
  _293 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.07046442461679249 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.054773082942097026 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.04756871035940803 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.046511627906976744 - nodes in this community are weakly interconnected._
- **Should `Community 4` be split into smaller, more focused modules?**
  _Cohesion score 0.06896551724137931 - nodes in this community are weakly interconnected._
