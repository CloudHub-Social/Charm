"""Synthetic-only regression cases for the existing release spec merger."""

import copy
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml


SCRIPT = Path(__file__).with_name("merge-do-app-spec.py")
SHA = "066d06c6da2e663f771b2a97eed1a01284422687"


class MergeSpecTests(unittest.TestCase):
    def setUp(self):
        self.secret = {"key": "TEST_KEY", "type": "SECRET", "value": "EV[synthetic-only]"}
        self.live = {"services": [{"name": "api", "envs": [self.secret,
            {"key": "OUT_OF_BAND", "value": "preserve"}]}], "region": "tor"}
        self.desired = {"services": [{"name": "api", "envs": [
            {"key": "TEST_KEY", "type": "SECRET"}]}]}

    def merge(self, sha=SHA):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, spec in [("live", self.live), ("desired", self.desired)]:
                (root / name).write_text(yaml.safe_dump(spec))
            output = root / "output"
            result = subprocess.run(
                [sys.executable, str(SCRIPT), str(root / "live"),
                 str(root / "desired"), str(output), sha],
                capture_output=True, text=True, check=False,
            )
            self.assertNotIn(self.secret["value"], result.stdout + result.stderr)
            return result, yaml.safe_load(output.read_text()) if output.exists() else None

    def test_preserves_live_state_and_binds_exact_source(self):
        original = copy.deepcopy(self.live)
        result, output = self.merge()
        self.assertEqual(result.returncode, 0, result.stderr)
        envs = {entry["key"]: entry for entry in output["services"][0]["envs"]}
        self.assertEqual(envs["TEST_KEY"], self.secret)
        self.assertEqual(envs["OUT_OF_BAND"]["value"], "preserve")
        self.assertEqual(envs["CHARM_WEB_SERVER_EXPECTED_SOURCE_SHA"]["value"], SHA)
        self.assertEqual(envs["CHARM_WEB_SERVER_SOURCE_SHA"]["value"], "${_self.COMMIT_HASH}")
        self.assertEqual(output["region"], original["region"])
        self.assertEqual(self.live, original)

    def test_missing_secret_produces_no_spec(self):
        self.live["services"][0]["envs"] = []
        result, output = self.merge()
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(output)

    def test_invalid_revision_produces_no_spec(self):
        for value in ["main", "", "a" * 39, "G" * 40, SHA + "\n"]:
            with self.subTest(value=value):
                result, output = self.merge(value)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(output)

    def test_provenance_never_overwrites_a_secret(self):
        for source in [self.live, self.desired]:
            for key in ["CHARM_WEB_SERVER_EXPECTED_SOURCE_SHA", "CHARM_WEB_SERVER_SOURCE_SHA"]:
                with self.subTest(key=key):
                    source["services"][0]["envs"].append({"key": key, "type": "SECRET"})
                    result, output = self.merge()
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIsNone(output)
                    source["services"][0]["envs"].pop()


if __name__ == "__main__":
    unittest.main()
