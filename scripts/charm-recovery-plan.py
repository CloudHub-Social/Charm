"""Pure plan for the one Charm retained-spec reconstruction; no provider writes.

This module intentionally has no command-line entry point. A reviewed operator
procedure must establish private custody and a positive no-instance signal
before a separately authorized update can be considered.
"""
import copy
import json
import os
import stat

APP = 'd920ec97-4a06-40e1-b1b5-9cbc903f5ec6'
FLAG = 'CHARM_WEB_SERVER_INVENTORY_INSPECT_ONLY'
GUARD = 'CHARM_WEB_SERVER_EXPECTED_SOURCE_SHA'
INSPECTION_REV = '0cfcb7099a7e1561455aac09c8e929f7c9ef1c9e'
PREVIOUS_GUARD = 'c2f15e84569e8228b7d024b558cacd662c4a9ef7'


def verify_readback(stream, payload):
    stream.seek(0)
    if stream.read() != payload:
        raise ValueError('snapshot readback mismatch')


def open_private_directory(path):
    """Walk directory descriptors without following symlinks or writable ancestors."""
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in path.split('/'):
            if not component:
                continue
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                              dir_fd=fd)
            os.close(fd)
            fd = next_fd
            info = os.fstat(fd)
            if info.st_uid not in (0, os.geteuid()) or stat.S_IMODE(info.st_mode) & 0o022:
                raise ValueError('snapshot ancestor is not trusted')
        info = os.fstat(fd)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('snapshot directory is not private')
        return fd
    except BaseException:
        os.close(fd)
        raise


def snapshot_current(spec, directory, filename):
    """Write exclusively in a pre-existing private directory and verify readback.

    Custody approval and encrypted storage/retention remain operator gates.
    The snapshot captures the current spec, not the lost original.
    """
    path = os.path.abspath(directory)
    if os.path.realpath(path) != path or os.path.basename(filename) != filename:
        raise ValueError('unsafe snapshot path')
    secrets = secret_entries(spec)
    if not secrets or any(not str(e.get('value', '')).startswith('EV[') for _, e in secrets):
        raise ValueError('provider encrypted entries unavailable')
    payload = json.dumps(spec, separators=(',', ':'), ensure_ascii=True).encode()
    dfd = open_private_directory(path)
    try:
        fd = os.open(filename, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=dfd)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'w+b', closefd=False) as out:
                out.write(payload)
                out.flush()
                os.fsync(fd)
                verify_readback(out, payload)
            os.fsync(dfd)
        except BaseException:
            # Best effort only: snapshots or filesystem backups may retain bytes.
            # Never continue to a provider mutation when custody is uncertain.
            try:
                os.unlink(filename, dir_fd=dfd)
                os.fsync(dfd)
            except OSError:
                raise RuntimeError('snapshot cleanup uncertain') from None
            raise
        finally:
            os.close(fd)
    finally:
        os.close(dfd)
    return payload


def secret_entries(value, path=()):
    if isinstance(value, dict):
        if value.get('type') == 'SECRET':
            return [(path, value)]
        return [entry for key, child in value.items()
                for entry in secret_entries(child, path + (key,))]
    if isinstance(value, list):
        return [entry for index, child in enumerate(value)
                for entry in secret_entries(child, path + (index,))]
    return []


def offline_observation(app_id, active_phase, active_archive, pending_or_in_progress, instances,
                        offline_response, no_known_competing_owner):
    """Assess caller assertions; this is not a provider receipt or a lock.

    A null instance result is unknown, not zero. It is allowed only under the
    distinct operational archive/offline boundary and never with live entries.
    """
    if (app_id != APP or active_phase != 'ACTIVE' or active_archive is not True
            or pending_or_in_progress is not False or (instances is not None and instances != [])
            or offline_response is not True or no_known_competing_owner is not True):
        raise ValueError('operational archive observation unavailable')


def plan(snapshot_bytes, current, app_id, active_phase, active_archive, pending_or_in_progress,
         instances, offline_response, no_known_competing_owner):
    """Validate supplied synthetic inputs and return a constrained copy.

    Caller-provided bytes and state are untrusted assertions, not evidence of
    durable custody or fresh provider state. This offline helper is not an
    authorization or safety gate for a provider update.
    """
    offline_observation(app_id, active_phase, active_archive, pending_or_in_progress, instances,
                        offline_response, no_known_competing_owner)
    if not isinstance(snapshot_bytes, bytes):
        raise ValueError('required recovery evidence unavailable')
    try:
        initial = json.loads(snapshot_bytes)
    except (ValueError, UnicodeDecodeError):
        raise ValueError('snapshot cannot be decoded') from None
    if not isinstance(initial, dict) or current != initial:
        raise ValueError('current spec drifted from verified snapshot')
    services = current.get('services')
    maintenance = current.get('maintenance')
    if (not isinstance(services, list) or len(services) != 1
            or services[0].get('name') != 'api'
            or current.get('workers') or current.get('jobs')
            or maintenance != {}):
        raise ValueError('unexpected app structure')
    envs = services[0].get('envs')
    if not isinstance(envs, list) or not all(isinstance(e, dict) for e in envs):
        raise ValueError('environment unavailable')
    flags = [e for e in envs if e.get('key') == FLAG]
    guards = [e for e in envs if e.get('key') == GUARD]
    if (flags != [{'key': FLAG, 'scope': 'RUN_TIME', 'type': 'GENERAL', 'value': '1'}]
            or len(guards) != 1 or guards[0].get('type') == 'SECRET'
            or guards[0].get('value') != INSPECTION_REV):
        raise ValueError('inspection bindings unexpected')
    secrets = secret_entries(initial)
    if not secrets or any(not str(entry.get('value', '')).startswith('EV[')
                          for _, entry in secrets):
        raise ValueError('provider encrypted entries unavailable')
    result = copy.deepcopy(initial)
    result['maintenance'] = {'archive': True}
    out = result['services'][0]['envs']
    out[:] = [e for e in out if e.get('key') != FLAG]
    next(e for e in out if e.get('key') == GUARD)['value'] = PREVIOUS_GUARD
    if secret_entries(result) != secrets:
        raise ValueError('provider encrypted entries changed')
    return result


def assess_offline_match(expected, actual, app_id, active_phase, active_archive, pending_or_in_progress,
              instances, offline_response, no_known_competing_owner, outcome_known):
    """Assess assertions only; never establish zero instances, custody or recovery."""
    offline_observation(app_id, active_phase, active_archive, pending_or_in_progress, instances,
                        offline_response, no_known_competing_owner)
    if (outcome_known is not True or actual != expected
            or secret_entries(actual) != secret_entries(expected)):
        raise ValueError('offline assessment incomplete')
    return {'spec_matches_supplied_expected': True,
            'instance_result': 'unknown' if instances is None else 'empty-list-reported',
            'recovery_verified': False}
