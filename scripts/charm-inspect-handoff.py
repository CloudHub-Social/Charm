#!/usr/bin/env python3
"""REVIEW CANDIDATE ONLY: one inspect deployment, bounded stop request, no retries.

Never log spec, provider response bodies, credentials, object metadata or logs.
This script is not approval to run. See charm-diagnostic-execution-plan.md.
"""
import copy
import datetime
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

APP = 'd920ec97-4a06-40e1-b1b5-9cbc903f5ec6'
ACCOUNT = 'bb346e009981b1b928a5b8e008f7021d'
BUCKET = 'charm-api-state-production'
SIZE = 'apps-s-1vcpu-0.5gb'
ORIGINAL_DIAGNOSTIC_SHA = 'eaffaf34d99a489dd2b01eb51b2de6acdb14d5ff'
# A real successor PR number must be set and independently reviewed after
# creation. Until then the candidate cannot request a provider update.
SUCCESSOR_PR = 621
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


def release_identities(revision, workflow_revision, original_pr, successor_pr, lineage):
    base = successor_pr.get('base') or {}
    repository = base.get('repo') or {}
    original_base = original_pr.get('base') or {}
    if (not re.fullmatch('[0-9a-f]{40}', revision or '')
            or not re.fullmatch('[0-9a-f]{40}', workflow_revision or '')
            or original_pr.get('number') != 614 or original_pr.get('merged') is not True
            or original_pr.get('merge_commit_sha') != ORIGINAL_DIAGNOSTIC_SHA
            or (original_base.get('repo') or {}).get('full_name') != 'CloudHub-Social/Charm'
            or original_base.get('ref') != 'main'
            or type(SUCCESSOR_PR) is not int or SUCCESSOR_PR <= 0
            or successor_pr.get('number') != SUCCESSOR_PR
            or successor_pr.get('merged') is not True
            or successor_pr.get('merge_commit_sha') != revision
            or repository.get('full_name') != 'CloudHub-Social/Charm'
            or base.get('ref') != 'main'
            or (lineage.get('merge_base_commit') or {}).get('sha') != ORIGINAL_DIAGNOSTIC_SHA
            or lineage.get('status') != 'ahead'
            or workflow_revision != revision):
        raise RuntimeError('immutable diagnostic or workflow identity not established')
    return revision, workflow_revision


def candidate_has_identity(deployment, revision):
    services = deployment.get('services') or []
    return (len(services) == 1 and services[0].get('name') == 'api'
            and services[0].get('source_commit_hash') == revision)


def require_reconciled_result(initial, retained, category):
    # Restoring the active archive alone does not prove the retained app spec
    # was restored. Never request another update to clean it up automatically.
    if retained != initial:
        raise RuntimeError('retained app spec differs from original; manual reconciliation required')
    if category not in CATEGORIES[:-1]:
        raise RuntimeError('no conclusive inventory category captured')


def read_candidate_until(deployment, token, deadline):
    # Retry transient reads only. Authorization denials and rate limits are
    # not retried, and a missing identity never permits cancellation.
    while True:
        try:
            return req(BASE + '/deployments/' + deployment, token)['deployment']
        except urllib.error.HTTPError as error:
            if error.code < 500:
                raise
        except (urllib.error.URLError, TimeoutError):
            pass
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('candidate read unavailable at deadline; reconcile')
        time.sleep(min(15, remaining))


def validate_off_attestation(original, revision, attestation, run_id, actor, now=None):
    if not isinstance(attestation, dict):
        raise RuntimeError('auto-deploy observation missing')
    if (attestation.get('app') != APP or attestation.get('component') != 'api'
            or attestation.get('revision') != revision or attestation.get('off') is not True
            or not re.fullmatch('[0-9]+', run_id or '')
            or attestation.get('run_id') != run_id or not actor
            or attestation.get('actor') != actor or attestation.get('run_attempt') != '1'):
        raise RuntimeError('auto-deploy observation identity invalid')
    observed = attestation.get('observed_at')
    try:
        if not isinstance(observed, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', observed):
            raise ValueError()
        timestamp = datetime.datetime.strptime(observed, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc).timestamp()
    except ValueError:
        raise RuntimeError('auto-deploy observation time invalid') from None
    age = (time.time() if now is None else now) - timestamp
    if not 0 <= age <= 300:
        raise RuntimeError('auto-deploy observation stale or future')
    services = original.get('services') or []
    if len(services) != 1 or services[0].get('name') != 'api':
        raise RuntimeError('auto-deploy observation target mismatch')
    if any(services[0].get(key) is not None for key in ('git', 'gitlab', 'bitbucket', 'image')):
        raise RuntimeError('conflicting provider source configuration')
    github = services[0].get('github')
    if not isinstance(github, dict) or github.get('repo') != 'CloudHub-Social/Charm' or github.get('branch') != 'main':
        raise RuntimeError('unexpected source route')
    # Missing is accepted only under the separate Off attestation; it is not
    # interpreted as false. An explicit contradictory or malformed value fails.
    if 'deploy_on_push' in github and github['deploy_on_push'] is not False:
        raise RuntimeError('provider auto-deploy observation contradictory or malformed')


def build_spec(original, revision, allow_unarchive=False, attestation=None, run_id=None, actor=None, now=None):
    validate_off_attestation(original, revision, attestation, run_id, actor, now)
    spec = copy.deepcopy(original)
    maintenance = spec.get('maintenance', {})
    if not isinstance(maintenance, dict) or not isinstance(maintenance.get('archive', False), bool):
        raise RuntimeError('invalid retained maintenance configuration')
    if maintenance.get('archive', False) and allow_unarchive is not True:
        raise RuntimeError('retained archive requires explicit unarchive opt-in')
    # The explicitly invoked diagnostic needs an unarchived proposal. Keep the
    # original unchanged so reconciliation requires its complete restoration.
    spec['maintenance'] = {**maintenance, 'archive': False}
    service = spec['services'][0]
    github = service.get('github') or {}
    if github.get('repo') != 'CloudHub-Social/Charm' or github.get('branch') != 'main':
        raise RuntimeError('unexpected source route')
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
    run_id = os.environ.get('GITHUB_RUN_ID')
    actor = os.environ.get('GITHUB_ACTOR')
    attestation = {
        'app': os.environ.get('CHARM_OBSERVED_APP_ID'),
        'component': os.environ.get('CHARM_OBSERVED_COMPONENT'),
        'revision': os.environ.get('CHARM_OBSERVED_REVISION'),
        'observed_at': os.environ.get('CHARM_OBSERVED_AT_UTC'),
        'off': os.environ.get('CHARM_OBSERVED_AUTODEPLOY_OFF') == 'true',
        'run_id': run_id,
        'run_attempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
        'actor': actor,
    }
    do_token = os.environ.get('DIGITALOCEAN_ACCESS_TOKEN')
    if (not do_token or os.environ.get('GITHUB_ACTIONS') != 'true'
            or os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'
            or os.environ.get('GITHUB_REF') != 'refs/heads/main'
            or os.environ.get('GITHUB_SHA') != revision
            or os.environ.get('CHARM_R2_PREFLIGHT') != 'empty'
            or os.environ.get('CHARM_BUDGET_HEADROOM') != 'confirmed'):
        raise RuntimeError('protected dispatch context or same-run source preflight absent')
    # Both the original diagnostic and a specific reviewed successor must be
    # immutable; an arbitrary current-main revision is insufficient.
    if type(SUCCESSOR_PR) is not int or SUCCESSOR_PR <= 0:
        raise RuntimeError('successor PR not pinned; no provider update permitted')
    pr = req('https://api.github.com/repos/CloudHub-Social/Charm/pulls/614', None)
    successor = req('https://api.github.com/repos/CloudHub-Social/Charm/pulls/' + str(SUCCESSOR_PR), None)
    lineage = req('https://api.github.com/repos/CloudHub-Social/Charm/compare/' + ORIGINAL_DIAGNOSTIC_SHA + '...' + revision, None)
    revision, workflow_revision = release_identities(
        revision, os.environ.get('GITHUB_WORKFLOW_SHA'), pr, successor, lineage)
    print('Workflow revision:', workflow_revision, '; diagnostic revision:', revision, flush=True)
    source_revision(revision)
    app, active, instances = app_state(do_token)
    initial = archived_state(app, active, instances)
    opt_in = os.environ.get('CHARM_ALLOW_ARCHIVED_RETAINED_SPEC')
    if opt_in not in ('true', 'false'):
        raise RuntimeError('invalid explicit unarchive opt-in')
    proposed = build_spec(initial, revision, allow_unarchive=opt_in == 'true',
                          attestation=attestation, run_id=run_id, actor=actor)
    print('Off attestation:', attestation['observed_at'], '; revision:', revision,
          '; run:', run_id, '; actor:', actor, flush=True)
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
    # Revalidate the same observation after the final read and before any PUT.
    validate_off_attestation(latest, revision, attestation, run_id, actor)
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
        deployment = read_candidate_until(DEPLOYMENT, do_token, deadline)
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
            latest = read_candidate_until(DEPLOYMENT, do_token, deadline)
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
        except (RuntimeError, KeyError, ValueError):
            time.sleep(15)
            continue
        require_reconciled_result(initial, post_app['spec'], category_seen)
        print('Archived state, original app spec and inventory category verified; destination postcheck required.', flush=True)
        return
    raise RuntimeError('rollback state remains unverified')


try:
    main()
except BaseException as error:
    # Never print provider exceptions or bodies; only phase and effect ambiguity.
    print('Stopped at', PHASE, '(' + type(error).__name__ + '); update attempted:', ATTEMPTED,
          '; cancel attempted:', CANCEL_ATTEMPTED, '; deployment:', DEPLOYMENT or 'unknown',
          '. Reconcile provider state before another mutation.', file=sys.stderr)
    sys.exit(1)
