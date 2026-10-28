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
        return {"active_deployment": {"spec": {"maintenance": {"archive": True}}},
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
