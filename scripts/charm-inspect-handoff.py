#!/usr/bin/env python3
"""REVIEW CANDIDATE ONLY: one inspect deployment, bounded stop request, no retries.

Never log spec, provider response bodies, credentials, object metadata or logs.
This script is not approval to run. See charm-diagnostic-execution-plan.md.
"""
import copy
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

APP = 'd920ec97-4a06-40e1-b1b5-9cbc903f5ec6'
ACCOUNT = 'bb346e009981b1b928a5b8e008f7021d'
BUCKET = 'charm-api-state-production'
SIZE = 'apps-s-1vcpu-0.5gb'
BASE = 'https://api.digitalocean.com/v2/apps/' + APP
CATEGORIES = (
    'state inventory within bounds',
    'state inventory rejected unexpected object path',
    'state inventory rejected oversized object',
    'state inventory exceeds total size bound',
    'state inventory exceeds object count bound',
    'state inventory inspection unavailable',
)
PHASE = 'initial preflight'
ATTEMPTED = False
CANCEL_ATTEMPTED = False
DEPLOYMENT = None


def req(url, token, method='GET', body=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(
        url, method=method, data=None if body is None else json.dumps(body).encode(),
        headers=headers,
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


def command(args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=30, **kwargs).stdout


def app_state(token):
    app = req(BASE, token)['app']
    active = app.get('active_deployment') or {}
    active_id = active.get('id')
    if not active_id:
        raise RuntimeError('active deployment missing')
    deployment = req(BASE + '/deployments/' + active_id, token)['deployment']
    env = dict(os.environ, DIGITALOCEAN_ACCESS_TOKEN=token)
    instances = json.loads(command(['doctl', 'apps', 'list-instances', APP,
                                    '--output', 'json', '--http-retry-max', '0'], env=env))
    return app, deployment, instances


def archived_state(app, active, instances):
    if app.get('pending_deployment') or app.get('in_progress_deployment'):
        raise RuntimeError('deployment already in progress')
    if active.get('phase') != 'ACTIVE' or (active.get('spec', {}).get('maintenance') or {}).get('archive') is not True:
        raise RuntimeError('active deployment not archived')
    if instances not in (None, []):
        raise RuntimeError('source has instances')
    spec = app['spec']
    services = spec.get('services') or []
    if len(services) != 1 or services[0].get('name') != 'api' or services[0].get('instance_count') != 1 or services[0].get('instance_size_slug') != SIZE or spec.get('jobs') or spec.get('workers'):
        raise RuntimeError('unexpected app capacity or components')
    return spec


def source_revision(revision):
    out = command(['git', 'ls-remote', 'origin', 'refs/heads/main']).decode().split()
    if not out or out[0] != revision:
        raise RuntimeError('qualified release is not current main')


def release_identities(revision, workflow_revision, pull_request):
    base = pull_request.get('base') or {}
    repository = base.get('repo') or {}
    if (not re.fullmatch('[0-9a-f]{40}', revision or '')
            or not re.fullmatch('[0-9a-f]{40}', workflow_revision or '')
            or pull_request.get('number') != 614
            or pull_request.get('merged') is not True
            or pull_request.get('merge_commit_sha') != revision
            or repository.get('full_name') != 'CloudHub-Social/Charm'
            or base.get('ref') != 'main'
            or workflow_revision != revision):
        raise RuntimeError('immutable diagnostic or workflow identity not established')
    return revision, workflow_revision


def candidate_has_identity(deployment, revision):
    services = deployment.get('services') or []
    return (len(services) == 1 and services[0].get('name') == 'api'
            and services[0].get('source_commit_hash') == revision)


def build_spec(original, revision):
    spec = copy.deepcopy(original)
    maintenance = spec.get('maintenance') or {}
    if not isinstance(maintenance, dict) or maintenance.get('archive', False) is not False:
        raise RuntimeError('diagnostic proposal must be unarchived')
    spec['maintenance'] = {**maintenance, 'archive': False}
    service = spec['services'][0]
    github = service.get('github') or {}
    if github.get('repo') != 'CloudHub-Social/Charm' or github.get('branch') != 'main':
        raise RuntimeError('unexpected source route')
    if github.get('deploy_on_push') is not False:
        raise RuntimeError('explicitly disabled provider auto-deploy not established')
    envs = service.get('envs') or []
    keys = [e.get('key') for e in envs]
    if len(keys) != len(set(keys)):
        raise RuntimeError('duplicate environment entries')
    by_key = {e.get('key'): e for e in envs}
    required_values = {
        'CHARM_WEB_SERVER_SPACES_BUCKET': 'charm-web-server-sessions',
        'CHARM_WEB_SERVER_SPACES_ENDPOINT': 'https://tor1.digitaloceanspaces.com',
        'CHARM_WEB_SERVER_STATE_BUCKET': BUCKET,
        'CHARM_WEB_SERVER_SOURCE_SHA': '${_self.COMMIT_HASH}',
    }
    if any(by_key.get(key, {}).get('value') != value for key, value in required_values.items()):
        raise RuntimeError('source or destination binding differs from approved scope')
    for key in ('CHARM_WEB_SERVER_SPACES_ACCESS_KEY_ID', 'CHARM_WEB_SERVER_SPACES_SECRET_ACCESS_KEY',
                'CHARM_WEB_SERVER_STATE_ACCESS_KEY_ID', 'CHARM_WEB_SERVER_STATE_SECRET_ACCESS_KEY'):
        if by_key.get(key, {}).get('type') != 'SECRET':
            raise RuntimeError('required encrypted credential binding missing')
    if any(e.get('key') == 'CHARM_WEB_SERVER_INVENTORY_INSPECT_ONLY' for e in envs):
        raise RuntimeError('inspection flag already present')
    for env in envs:
        if env.get('type') == 'SECRET' and not str(env.get('value', '')).startswith('EV['):
            raise RuntimeError('encrypted secret entry unavailable')
    guards = [e for e in envs if e.get('key') == 'CHARM_WEB_SERVER_EXPECTED_SOURCE_SHA']
    if len(guards) != 1 or guards[0].get('type') == 'SECRET':
        raise RuntimeError('release guard binding unavailable')
    guards[0]['value'] = revision
    envs.append({'key': 'CHARM_WEB_SERVER_INVENTORY_INSPECT_ONLY', 'scope': 'RUN_TIME', 'type': 'GENERAL', 'value': '1'})
    service['envs'] = envs
    # No secret entry is transformed. Other spec fields are copied exactly.
    old_secrets = [e for e in original['services'][0].get('envs', []) if e.get('type') == 'SECRET']
    new_secrets = [e for e in envs if e.get('type') == 'SECRET']
    if old_secrets != new_secrets:
        raise RuntimeError('secret entries changed')
    return spec


def secret_entries(value, path=()):
    """Keep complete entries and paths in memory; never report their contents."""
    if isinstance(value, dict):
        if value.get('type') == 'SECRET':
            return [(path, value)]
        return [entry for key, child in value.items()
                for entry in secret_entries(child, path + (key,))]
    if isinstance(value, list):
        return [entry for index, child in enumerate(value)
                for entry in secret_entries(child, path + (index,))]
    return []


def logs(deployment, token):
    env = dict(os.environ, DIGITALOCEAN_ACCESS_TOKEN=token)
    try:
        raw = command(['doctl', 'apps', 'logs', APP, 'api', '--deployment', deployment,
                       '--type', 'run', '--tail', '100', '--http-retry-max', '0'], env=env)
    except (subprocess.SubprocessError, OSError):
        return None, None
    text = raw.decode('utf-8', 'replace')
    for line in text.splitlines():
        for category in CATEGORIES:
            if category in line:
                return category, bool(text)
    return None, bool(text)


def main():
    global PHASE, ATTEMPTED, CANCEL_ATTEMPTED, DEPLOYMENT
    if len(sys.argv) != 4 or sys.argv[2:] != ['--execute', '--coordinated-sole-writer'] or not re.fullmatch('[0-9a-f]{40}', sys.argv[1]):
        raise RuntimeError('expected qualified main SHA, explicit execute flag and sole-writer acknowledgment')
    revision = sys.argv[1]
    do_token = os.environ.get('DIGITALOCEAN_ACCESS_TOKEN')
    if (not do_token or os.environ.get('GITHUB_ACTIONS') != 'true'
            or os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'
            or os.environ.get('GITHUB_REF') != 'refs/heads/main'
            or os.environ.get('GITHUB_SHA') != revision
            or os.environ.get('CHARM_R2_PREFLIGHT') != 'empty'
            or os.environ.get('CHARM_BUDGET_HEADROOM') != 'confirmed'):
        raise RuntimeError('protected dispatch context or same-run source preflight absent')
    # PR #614's immutable merge SHA is the approved source pin; merely being
    # current main is insufficient. Workflow and source identities are distinct
    # facts and must both identify this protected merge for this release route.
    pr = req('https://api.github.com/repos/CloudHub-Social/Charm/pulls/614', None)
    revision, workflow_revision = release_identities(
        revision, os.environ.get('GITHUB_WORKFLOW_SHA'), pr)
    print('Workflow revision:', workflow_revision, '; diagnostic revision:', revision, flush=True)
    source_revision(revision)
    app, active, instances = app_state(do_token)
    initial = archived_state(app, active, instances)
    proposed = build_spec(initial, revision)
    initial_secrets = secret_entries(initial)
    if secret_entries(proposed) != initial_secrets:
        raise RuntimeError('complete secret entries changed')
    baseline_id = active['id']
    # Re-read complete spec and archive state immediately before the one PUT.
    PHASE = 'final drift check'
    source_revision(revision)
    now_app, now_active, now_instances = app_state(do_token)
    latest = archived_state(now_app, now_active, now_instances)
    if latest != initial or now_active['id'] != baseline_id:
        raise RuntimeError('app or active deployment drifted')
    PHASE = 'single update'
    started = time.monotonic()
    ATTEMPTED = True  # Includes unknown response outcomes.
    # The spec stays in memory and is piped to doctl's inherited stdin.
    env = dict(os.environ, DIGITALOCEAN_ACCESS_TOKEN=do_token)
    child = subprocess.Popen(['doctl', 'apps', 'update', APP, '--spec', '/dev/stdin',
                              '--update-sources', '--http-retry-max', '0', '--output', 'json'],
                             env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE)
    try:
        raw, _ = child.communicate(json.dumps(proposed).encode(), timeout=30)
    except subprocess.TimeoutExpired:
        child.kill()
        child.communicate()
        raise RuntimeError('provider update result uncertain')
    if child.returncode != 0:
        raise RuntimeError('provider update result uncertain')
    updated = json.loads(raw)
    updated = updated[0] if isinstance(updated, list) and len(updated) == 1 else updated
    if not isinstance(updated, dict):
        raise RuntimeError('provider update result uncertain')
    DEPLOYMENT = ((updated.get('in_progress_deployment') or updated.get('pending_deployment') or {}).get('id'))
    if not DEPLOYMENT:
        fresh = req(BASE, do_token)['app']
        DEPLOYMENT = ((fresh.get('in_progress_deployment') or fresh.get('pending_deployment') or {}).get('id'))
    if not DEPLOYMENT or not re.fullmatch('[0-9a-f-]{36}', DEPLOYMENT) or DEPLOYMENT == baseline_id:
        raise RuntimeError('candidate identity uncertain; reconcile before mutation')
    print('Candidate deployment accepted:', DEPLOYMENT, flush=True)
    PHASE = 'observe candidate'
    first_runtime = None
    category_seen = None
    deadline = started + 30 * 60
    while True:
        deployment = req(BASE + '/deployments/' + DEPLOYMENT, do_token)['deployment']
        # The category can appear before the first successful status read.
        identified = candidate_has_identity(deployment, revision)
        category, saw_runtime = logs(DEPLOYMENT, do_token) if identified else (None, False)
        if saw_runtime and first_runtime is None:
            first_runtime = time.monotonic()
            deadline = min(deadline, first_runtime + 5 * 60)
        if category and not category_seen:
            category_seen = category
            print(category, flush=True)
        phase = deployment.get('phase')
        if phase in ('ERROR', 'CANCELED', 'CANCELLED'):
            if not identified:
                raise RuntimeError('terminal candidate source identity unavailable')
            print('Candidate terminal:', phase, flush=True)
            break
        if phase == 'ACTIVE':
            raise RuntimeError('candidate unexpectedly active; reconcile without cancellation')
        if category_seen or time.monotonic() >= deadline:
            # Fresh read avoids knowingly cancelling a terminal deployment.
            latest = req(BASE + '/deployments/' + DEPLOYMENT, do_token)['deployment']
            if not candidate_has_identity(latest, revision):
                raise RuntimeError('candidate source identity unavailable; no cancellation')
            current = latest.get('phase')
            if current in ('ERROR', 'CANCELED', 'CANCELLED'):
                print('Candidate terminal:', current, flush=True)
                break
            if current not in ('PENDING_BUILD', 'BUILDING', 'PENDING_DEPLOY', 'DEPLOYING'):
                raise RuntimeError('candidate no longer cancellable; reconcile')
            PHASE = 'single cancellation request'
            CANCEL_ATTEMPTED = True
            req(BASE + '/deployments/' + DEPLOYMENT + '/cancel', do_token, 'POST')
            print('Cancellation request accepted; reconcile provider state.', flush=True)
            break
        time.sleep(15)
    # No manual rollback. Bound observation, then report whether archive is proven.
    PHASE = 'rollback reconciliation'
    end = time.monotonic() + 5 * 60
    while time.monotonic() < end:
        try:
            post_app, post_active, post_instances = app_state(do_token)
            archived_state(post_app, post_active, post_instances)
            if secret_entries(post_app['spec']) != initial_secrets:
                raise RuntimeError('complete encrypted entries changed')
            print('Archived zero-instance state and encrypted entries verified; destination postcheck required.', flush=True)
            return
        except (RuntimeError, KeyError, ValueError):
            time.sleep(15)
    raise RuntimeError('rollback state remains unverified')


try:
    main()
except BaseException as error:
    # Never print provider exceptions or bodies; only phase and effect ambiguity.
    print('Stopped at', PHASE, '(' + type(error).__name__ + '); update attempted:', ATTEMPTED,
          '; cancel attempted:', CANCEL_ATTEMPTED, '; deployment:', DEPLOYMENT or 'unknown',
          '. Reconcile provider state before another mutation.', file=sys.stderr)
    sys.exit(1)
