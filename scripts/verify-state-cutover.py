#!/usr/bin/env python3
"""Read-only controller gate. Never emit app configuration or secret values."""
import json
import subprocess
import sys

APP = "d920ec97-4a06-40e1-b1b5-9cbc903f5ec6"


def validate(app, instances, revision=None):
    active = app.get("active_deployment") or {}
    maintenance = (active.get("spec") or {}).get("maintenance") or {}
    if app.get("pending_deployment"):
        raise ValueError("pending rollout prevents cutover")
    active_spec = active.get("spec") or {}
    services = active_spec.get("services") or []
    if revision and active.get("phase") == "ACTIVE" and not maintenance.get("archive") and len(services) == 1:
        env = {e.get("key"): e.get("value") for e in services[0].get("envs", [])}
        # This exact guarded binary cannot serve before committing migration.
        # Permit its later same-revision restart without consulting stale sources.
        if (env.get("CHARM_WEB_SERVER_STATE_BUCKET") == "charm-api-state-production"
                and env.get("CHARM_WEB_SERVER_EXPECTED_SOURCE_SHA") == revision
                and env.get("CHARM_WEB_SERVER_STATE_CUTOVER_SHA") == revision
                and len(instances) == 1 and services[0].get("instance_count") == 1):
            return
    if not maintenance.get("archive"):
        raise ValueError("cutover requires archived active deployment and no pending rollout")
    if instances:
        raise ValueError("cutover requires zero source instances")
    services = (app.get("spec") or {}).get("services") or []
    if len(services) != 1 or services[0].get("instance_count") != 1:
        raise ValueError("cutover requires existing single-instance capacity")
    if (app.get("spec") or {}).get("workers") or (app.get("spec") or {}).get("jobs"):
        raise ValueError("unexpected background components prevent cutover")


def read(*args):
    result = subprocess.run(["doctl", "apps", *args, "--output", "json"],
                            capture_output=True, check=False)
    if result.returncode:
        raise ValueError("provider preflight read failed")
    return json.loads(result.stdout)


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3 or sys.argv[1] != APP:
            raise ValueError("cutover app differs from approved target")
        apps = read("get", APP)
        app = apps[0] if isinstance(apps, list) else apps
        instances = read("list-instances", APP)
        if not isinstance(instances, list):
            raise ValueError("unknown provider instance response")
        validate(app, instances, sys.argv[2])
        print("Verified stopped initial source or active same-revision R2 authority")
    except (ValueError, KeyError, TypeError):
        sys.exit("State cutover preflight failed; no update authorized by this gate")
