"""Synthetic controller receipts only; never contact a provider."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "state_cutover", Path(__file__).with_name("verify-state-cutover.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CutoverTest(unittest.TestCase):
    def valid(self):
        return {"active_deployment": {"spec": {"maintenance": {"archive": True}, "services": [{"name": "api", "instance_count": 1}]}},
                "spec": {"services": [{"instance_count": 1}]}}

    def test_archived_without_instances(self):
        module.validate(self.valid(), [])

    def test_live_source_rejected(self):
        app = self.valid()
        app["active_deployment"]["spec"]["maintenance"]["archive"] = False
        with self.assertRaises(ValueError):
            module.validate(app, [])

    def test_instance_and_pending_rollout_rejected(self):
        with self.assertRaises(ValueError):
            module.validate(self.valid(), [{"id": "synthetic"}])
        app = self.valid()
        app["pending_deployment"] = {"id": "synthetic"}
        with self.assertRaises(ValueError):
            module.validate(app, [])

    def test_extra_background_writer_rejected(self):
        app = self.valid()
        app["spec"]["workers"] = [{"name": "synthetic"}]
        with self.assertRaises(ValueError):
            module.validate(app, [])

    def test_completed_same_revision_restart(self):
        app = self.valid()
        app["active_deployment"] = {"phase": "ACTIVE", "services": [{"name": "api", "source_commit_hash": "qualified"}], "spec": {"services": [{"name": "api",
            "instance_count": 1, "envs": [
                {"key": "CHARM_WEB_SERVER_STATE_BUCKET", "value": "charm-api-state-production"},
                {"key": "CHARM_WEB_SERVER_EXPECTED_SOURCE_SHA", "value": "qualified"},
                {"key": "CHARM_WEB_SERVER_STATE_CUTOVER_SHA", "value": "qualified"}]}]}}
        module.validate(app, [{"id": "synthetic"}], "qualified")
        with self.assertRaises(ValueError):
            module.validate(app, [{"id": "synthetic"}], "different")

        app["active_deployment"]["services"][0]["source_commit_hash"] = "legacy"
        with self.assertRaises(ValueError):
            module.validate(app, [{"id": "synthetic"}], "qualified")
        app["active_deployment"]["services"][0]["source_commit_hash"] = "qualified"
        app["active_deployment"]["spec"]["jobs"] = [{"name": "unexpected"}]
        with self.assertRaises(ValueError):
            module.validate(app, [{"id": "synthetic"}], "qualified")
