#!/usr/bin/env python3
"""Read-only controller gate. Never emit app configuration or secret values."""
import json
import subprocess
import sys

APP = "d920ec97-4a06-40e1-b1b5-9cbc903f5ec6"
INSTANCE_SIZE = "apps-s-1vcpu-0.5gb"


def validate(app, instances, revision=None):
    active = app.get("active_deployment") or {}
    maintenance = (active.get("spec") or {}).get("maintenance") or {}
    if app.get("pending_deployment") or app.get("in_progress_deployment"):
        raise ValueError("pending rollout prevents cutover")
    active_spec = active.get("spec") or {}
    services = active_spec.get("services") or []
    archived = maintenance.get("archive") is True and active.get("phase") == "ACTIVE"
    # doctl v2's successful instance command JSON-encodes a nil Go slice as
    # null. Accept that empty representation only with positive archive proof.
    if instances is None and archived:
        instances = []
    if not isinstance(instances, list):
        raise ValueError("unknown provider instance response")
    for candidate in [app.get("spec") or {}, active_spec]:
        if candidate.get("workers") or candidate.get("jobs"):
            raise ValueError("unexpected background components prevent cutover")
        configured = candidate.get("services") or []
        # The archived deployment is a maintenance-only spec. The retained
        # app spec still owns the single service and its unchanged capacity.
        if candidate is active_spec and archived and not configured:
            continue
        if (len(configured) != 1 or configured[0].get("name") != "api"
                or configured[0].get("instance_count") != 1
                or configured[0].get("instance_size_slug") != INSTANCE_SIZE):
            raise ValueError("cutover requires existing single-instance capacity")
    deployed = active.get("services") or []
    actual_revision_matches = (len(services) == 1 and len(deployed) == 1
                               and deployed[0].get("name") == services[0].get("name")
                               and deployed[0].get("source_commit_hash") == revision)
    if revision and actual_revision_matches and active.get("phase") == "ACTIVE" and not maintenance.get("archive") and len(services) == 1:
        env = {e.get("key"): e.get("value") for e in services[0].get("envs", [])}
        # This exact guarded binary cannot serve before committing migration.
        # Permit its later same-revision restart without consulting stale sources.
        if (env.get("CHARM_WEB_SERVER_STATE_BUCKET") == "charm-api-state-production"
                and env.get("CHARM_WEB_SERVER_EXPECTED_SOURCE_SHA") == revision
                and env.get("CHARM_WEB_SERVER_STATE_CUTOVER_SHA") == revision
                and len(instances) == 1 and services[0].get("instance_count") == 1):
            return
    if not archived:
        raise ValueError("cutover requires archived active deployment and no pending rollout")
    if instances:
        raise ValueError("cutover requires zero source instances")
    services = (app.get("spec") or {}).get("services") or []
    if len(services) != 1 or services[0].get("instance_count") != 1:
        raise ValueError("cutover requires existing single-instance capacity")
    if (app.get("spec") or {}).get("workers") or (app.get("spec") or {}).get("jobs"):
        raise ValueError("unexpected background components prevent cutover")
    # An archived source is not sufficient when state migration would reject
    # the proposed binary: stop before requesting a rollout.
    envs = services[0].get("envs") or []
    if any(e.get("key", "").startswith("CHARM_WEB_SERVER_STATE_") for e in envs):
        cutover = [e.get("value") for e in envs if e.get("key") == "CHARM_WEB_SERVER_STATE_CUTOVER_SHA"]
        if not revision or cutover != [revision]:
            raise ValueError("state cutover does not match proposed revision")


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
        deployment_id = (app.get("active_deployment") or {}).get("id")
        if not deployment_id:
            raise ValueError("active deployment identity missing")
        deployment = read("get-deployment", APP, deployment_id)
        app["active_deployment"] = deployment[0] if isinstance(deployment, list) else deployment
        instances = read("list-instances", APP)
        validate(app, instances, sys.argv[2])
        print("Verified stopped initial source or active same-revision R2 authority")
    except (ValueError, KeyError, TypeError):
        sys.exit("State cutover preflight failed; no update authorized by this gate")
