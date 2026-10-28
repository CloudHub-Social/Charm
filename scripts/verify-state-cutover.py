#!/usr/bin/env python3
"""Read-only controller gate. Never emit app configuration or secret values."""
import json
import subprocess
import sys

APP = "d920ec97-4a06-40e1-b1b5-9cbc903f5ec6"


def validate(app, instances):
    active = app.get("active_deployment") or {}
    maintenance = (active.get("spec") or {}).get("maintenance") or {}
    if not maintenance.get("archive") or app.get("pending_deployment"):
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
        if len(sys.argv) != 2 or sys.argv[1] != APP:
            raise ValueError("cutover app differs from approved target")
        apps = read("get", APP)
        app = apps[0] if isinstance(apps, list) else apps
        instances = read("list-instances", APP)
        if not isinstance(instances, list):
            raise ValueError("unknown provider instance response")
        validate(app, instances)
        print("Verified archived source, zero instances, no rollout, unchanged capacity")
    except (ValueError, KeyError, TypeError):
        sys.exit("State cutover preflight failed; no update authorized by this gate")
