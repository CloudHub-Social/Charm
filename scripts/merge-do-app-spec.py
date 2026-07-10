#!/usr/bin/env python3
"""Merges .do/app.yaml's structural config onto the live DigitalOcean App
Platform spec, without ever touching a SECRET-type env var's real value.

Why this exists (see web-server-deploy.yml's "Apply the current app spec"
step): DO's `doctl apps update --spec` is a full replace, not a merge. The
committed .do/app.yaml has no `value:` for its SECRET-type envs — git can
never hold that plaintext — so submitting it directly wipes every secret to
empty on every single deploy. That crashed production twice in a row before
this script existed (DeployContainerExitNonZero / "must decode to exactly
32 bytes, got 0", PR #141). Instead: fetch the live spec (whose SECRET envs
already carry DO's real encrypted EV[...] values) and patch only the
structural fields .do/app.yaml is meant to drive onto it.

Usage: merge-do-app-spec.py <live-spec.yaml> <repo-spec.yaml> <output.yaml>
"""

import sys

import yaml

STRUCTURAL_FIELDS = (
    "github",
    "dockerfile_path",
    "source_dir",
    "http_port",
    "instance_count",
    "instance_size_slug",
    "health_check",
)


def find_service(spec: dict, name: str) -> dict:
    for svc in spec.get("services", []):
        if svc.get("name") == name:
            return svc
    raise SystemExit(f"service '{name}' not found in spec (services present: "
                      f"{[s.get('name') for s in spec.get('services', [])]})")


def main() -> None:
    live_path, repo_path, output_path = sys.argv[1:4]

    with open(live_path) as f:
        live = yaml.safe_load(f)
    with open(repo_path) as f:
        desired = yaml.safe_load(f)

    # The repo spec is expected to define exactly one service (this script
    # is single-purpose to charm-web-server's one-component app) — but the
    # *live* spec is looked up by that service's name rather than assumed to
    # be services[0], so this can't silently merge into the wrong component
    # if DO ever reorders services or another one gets added.
    desired_svc = desired["services"][0]
    live_svc = find_service(live, desired_svc["name"])

    # Several of these (source_dir, http_port, health_check, ...) are
    # optional in the DO app spec — if the repo spec omits one, leave
    # whatever's live untouched rather than crashing on a KeyError or
    # writing an explicit `null` over a real configured value.
    for field in STRUCTURAL_FIELDS:
        if field in desired_svc:
            live_svc[field] = desired_svc[field]

    # Envs: RUN_TIME (non-secret) values come from the repo spec every time.
    # SECRET entries keep whatever's already live (their real EV[...]
    # value) — the repo spec intentionally has no `value:` for these, and
    # that must never be treated as "clear it". Any env that exists live but
    # isn't mentioned in the repo spec at all — most importantly a SECRET
    # added or managed out-of-band via the DO dashboard — is preserved
    # as-is rather than dropped: rebuilding the env list purely from the
    # repo spec's entries would silently delete it, which is exactly the
    # class of bug this script exists to prevent in the first place.
    live_envs_by_key = {e["key"]: e for e in live_svc.get("envs", [])}
    merged_envs = []
    seen_keys = set()
    missing_secrets = []
    for desired_env in desired_svc.get("envs", []):
        key = desired_env["key"]
        seen_keys.add(key)
        if desired_env.get("type") == "SECRET":
            live_env = live_envs_by_key.get(key)
            if live_env is None:
                missing_secrets.append(key)
            else:
                merged_envs.append(live_env)
        else:
            merged_envs.append(desired_env)
    for live_env in live_svc.get("envs", []):
        if live_env["key"] not in seen_keys:
            merged_envs.append(live_env)

    # A repo-declared SECRET with no live value yet must stop the deploy
    # here, before anything is written or submitted — not warn-and-continue.
    # The caller (`doctl apps update` immediately followed by
    # `apps create-deployment --wait`) would otherwise submit an
    # empty-valued secret and roll it straight to production, which is
    # exactly the class of incident (DeployContainerExitNonZero / "must
    # decode to exactly 32 bytes, got 0") this whole script exists to
    # prevent. There's no legitimate case where this script runs against a
    # newly-provisioned app with no secrets at all — initial provisioning
    # goes through `doctl apps create` directly (see .do/app.yaml's header
    # comment), never through this merge step.
    if missing_secrets:
        for key in missing_secrets:
            print(
                f"::error::{key} is declared as a SECRET in {repo_path} but has "
                "no live value on the app — set it via the DO dashboard before "
                "deploying. Refusing to submit a spec that would deploy it "
                "empty.",
                file=sys.stderr,
            )
        raise SystemExit(1)

    live_svc["envs"] = merged_envs

    with open(output_path, "w") as f:
        yaml.safe_dump(live, f, sort_keys=False)


if __name__ == "__main__":
    main()
