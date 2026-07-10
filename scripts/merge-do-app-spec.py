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


def main() -> None:
    live_path, repo_path, output_path = sys.argv[1:4]

    with open(live_path) as f:
        live = yaml.safe_load(f)
    with open(repo_path) as f:
        desired = yaml.safe_load(f)

    live_svc = live["services"][0]
    desired_svc = desired["services"][0]

    for field in STRUCTURAL_FIELDS:
        live_svc[field] = desired_svc[field]

    # Envs: RUN_TIME (non-secret) values come from the repo spec every time.
    # SECRET entries keep whatever's already live (their real EV[...]
    # value) — the repo spec intentionally has no `value:` for these, and
    # that must never be treated as "clear it".
    live_envs_by_key = {e["key"]: e for e in live_svc.get("envs", [])}
    merged_envs = []
    for desired_env in desired_svc.get("envs", []):
        key = desired_env["key"]
        if desired_env.get("type") == "SECRET":
            live_env = live_envs_by_key.get(key)
            if live_env is None:
                print(
                    f"::warning::{key} has no live value yet — set it via the "
                    "DO dashboard before this deploy is expected to work.",
                    file=sys.stderr,
                )
                merged_envs.append(desired_env)
            else:
                merged_envs.append(live_env)
        else:
            merged_envs.append(desired_env)
    live_svc["envs"] = merged_envs

    with open(output_path, "w") as f:
        yaml.safe_dump(live, f, sort_keys=False)


if __name__ == "__main__":
    main()
