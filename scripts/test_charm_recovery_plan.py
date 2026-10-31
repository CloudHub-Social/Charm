import copy
import io
import json
import os
import runpy
import tempfile
from pathlib import Path
from unittest import TestCase, main, mock

module = runpy.run_path(str(Path(__file__).with_name('charm-recovery-plan.py')))
plan, assess = module['plan'], module['assess_offline_match']
snapshot_current = module['snapshot_current']
APP, FLAG, GUARD = module['APP'], module['FLAG'], module['GUARD']
REV, PREV = module['INSPECTION_REV'], module['PREVIOUS_GUARD']


def sample():
    return {'maintenance': {}, 'services': [{'name': 'api', 'envs': [
        {'key': 'secret', 'type': 'SECRET', 'value': 'EV[synthetic]'},
        {'key': GUARD, 'type': 'GENERAL', 'value': REV},
        {'key': FLAG, 'scope': 'RUN_TIME', 'type': 'GENERAL', 'value': '1'},
    ]}]}


def encoded(value):
    return json.dumps(value).encode()


class RecoveryPlan(TestCase):
    def test_snapshot_exclusive_and_private(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as directory:
            directory = os.path.realpath(directory)
            os.chmod(directory, 0o700)
            self.assertEqual(json.loads(snapshot_current(sample(), directory, 'state.json')), sample())
            self.assertEqual(os.stat(Path(directory) / 'state.json').st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                snapshot_current(sample(), directory, 'state.json')

    def test_snapshot_readback_failure_stops(self):
        with self.assertRaises(ValueError):
            module['verify_readback'](io.BytesIO(b'changed'), b'expected')
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as directory:
            directory = os.path.realpath(directory)
            os.chmod(directory, 0o700)
            with mock.patch('os.fsync', side_effect=[OSError('synthetic failure'), None]):
                with self.assertRaises(OSError):
                    snapshot_current(sample(), directory, 'state.json')

    def test_failed_partial_snapshot_cleanup_is_reported(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as directory:
            directory = os.path.realpath(directory)
            os.chmod(directory, 0o700)
            with mock.patch('os.fsync', side_effect=OSError('synthetic failure')):
                with mock.patch('os.unlink', side_effect=OSError('synthetic cleanup failure')):
                    with self.assertRaisesRegex(RuntimeError, 'snapshot cleanup uncertain'):
                        snapshot_current(sample(), directory, 'state.json')

    def test_failed_cleanup_directory_sync_is_reported(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as directory:
            directory = os.path.realpath(directory)
            os.chmod(directory, 0o700)
            with mock.patch('os.fsync', side_effect=OSError('synthetic failure')):
                with self.assertRaisesRegex(RuntimeError, 'snapshot cleanup uncertain'):
                    snapshot_current(sample(), directory, 'state.json')

    def test_plaintext_never_written_and_symlink_path_rejected(self):
        with tempfile.TemporaryDirectory(dir=os.getcwd()) as directory:
            directory = os.path.realpath(directory)
            os.chmod(directory, 0o700)
            spec = sample()
            spec['services'][0]['envs'][0]['value'] = 'synthetic-plaintext'
            with self.assertRaises(ValueError):
                snapshot_current(spec, directory, 'state.json')
            self.assertFalse((Path(directory) / 'state.json').exists())
            os.symlink(directory, Path(directory) / 'link')
            with self.assertRaises(ValueError):
                snapshot_current(sample(), str(Path(directory) / 'link'), 'state.json')

    def test_three_fields_only_and_secret_preserved(self):
        initial = sample()
        proposed = plan(encoded(initial), copy.deepcopy(initial), APP, 'ACTIVE', True, False, [], True, True)
        self.assertEqual(proposed['maintenance'], {'archive': True})
        envs = proposed['services'][0]['envs']
        self.assertFalse(any(x['key'] == FLAG for x in envs))
        self.assertEqual(next(x for x in envs if x['key'] == GUARD)['value'], PREV)
        self.assertEqual(envs[0], initial['services'][0]['envs'][0])
        self.assertEqual(initial, sample())

    def test_missing_snapshot_and_drift_fail(self):
        initial = sample()
        for captured, current in [(True, initial), (encoded({}), initial), (encoded(initial), {})]:
            with self.subTest(captured=captured), self.assertRaises(ValueError):
                plan(captured, current, APP, 'ACTIVE', True, False, [], True, True)

    def test_unknown_instance_count_uses_separate_offline_evidence(self):
        initial = sample()
        self.assertTrue(plan(encoded(initial), initial, APP, 'ACTIVE', True, False, None, True, True))
        for archive, instances, offline, owner in [(False, [], True, True), (None, [], True, True),
                                                    (True, None, False, True), (True, None, True, False),
                                                    (True, ['live'], True, True)]:
            with self.subTest(archive=archive, instances=instances), self.assertRaises(ValueError):
                plan(encoded(initial), initial, APP, 'ACTIVE', archive, False, instances, offline, owner)
        for phase, pending in [('BUILDING', False), ('ACTIVE', True), ('ACTIVE', None)]:
            with self.subTest(phase=phase, pending=pending), self.assertRaises(ValueError):
                plan(encoded(initial), initial, APP, phase, True, pending, None, True, True)
        for app, offline, owner in [('different-app', True, True), (APP, None, True),
                                    (APP, 'true', True), (APP, True, None), (APP, True, 'true')]:
            with self.subTest(app=app, offline=offline, owner=owner), self.assertRaises(ValueError):
                plan(encoded(initial), initial, app, 'ACTIVE', True, False, None, offline, owner)

    def test_duplicates_and_unencrypted_secret_fail(self):
        for edit in ('duplicate', 'plaintext'):
            initial = sample()
            if edit == 'duplicate':
                initial['services'][0]['envs'].append(copy.deepcopy(initial['services'][0]['envs'][-1]))
            else:
                initial['services'][0]['envs'][0]['value'] = 'synthetic-plaintext'
            with self.subTest(edit=edit), self.assertRaises(ValueError):
                plan(encoded(initial), initial, APP, 'ACTIVE', True, False, [], True, True)

    def test_reconciliation_rejects_uncertainty_and_retained_drift(self):
        expected = plan(encoded(sample()), sample(), APP, 'ACTIVE', True, False, [], True, True)
        for actual, known, offline in [(expected, False, True), ({}, True, True), (expected, True, False)]:
            with self.subTest(known=known, offline=offline), self.assertRaises(ValueError):
                assess(expected, actual, APP, 'ACTIVE', True, False, None, offline, True, known)
        assessment = assess(expected, copy.deepcopy(expected), APP, 'ACTIVE', True, False, None, True, True, True)
        self.assertEqual(assessment['instance_result'], 'unknown')
        self.assertFalse(assessment['recovery_verified'])


if __name__ == '__main__':
    main()
