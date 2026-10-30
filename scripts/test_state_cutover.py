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
        service = {"name": "api", "instance_count": 1, "instance_size_slug": "apps-s-1vcpu-0.5gb"}
        return {"active_deployment": {"phase": "ACTIVE", "spec": {"maintenance": {"archive": True}, "services": [service.copy()]}},
                "spec": {"services": [service.copy()]}}

    def test_archived_without_instances(self):
        module.validate(self.valid(), [])

    def test_archived_maintenance_only_spec_and_nil_instance_slice(self):
        app = self.valid()
        app["active_deployment"]["spec"].pop("services")
        module.validate(app, None)
        module.validate(app, [])
        for unknown in [{}, "", 0]:
            with self.assertRaises(ValueError):
                module.validate(app, unknown)
        app["active_deployment"]["phase"] = "BUILDING"
        with self.assertRaises(ValueError):
            module.validate(app, None)

    def test_in_progress_deployment_rejected(self):
        app = self.valid()
        app["in_progress_deployment"] = {"id": "synthetic"}
        with self.assertRaises(ValueError):
            module.validate(app, [])

    def test_empty_retained_service_configuration_rejected(self):
        app = self.valid()
        app["spec"]["services"] = []
        with self.assertRaises(ValueError):
            module.validate(app, [])

    def test_wrong_or_missing_service_capacity_rejected(self):
        for location in ["spec", "active"]:
            for key, value in [("instance_size_slug", "apps-s-1vcpu-1gb"),
                               ("instance_size_slug", None), ("name", "other")]:
                app = self.valid()
                target = app["spec"] if location == "spec" else app["active_deployment"]["spec"]
                target["services"][0][key] = value
                with self.assertRaises(ValueError):
                    module.validate(app, [])

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
            "instance_count": 1, "instance_size_slug": "apps-s-1vcpu-0.5gb", "envs": [
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
        env = app["active_deployment"]["spec"]["services"][0]["envs"]
        for key in ["CHARM_WEB_SERVER_STATE_BUCKET", "CHARM_WEB_SERVER_EXPECTED_SOURCE_SHA", "CHARM_WEB_SERVER_STATE_CUTOVER_SHA"]:
            binding = next(entry for entry in env if entry["key"] == key)
            original = binding["value"]
            for value in [None, "", "stale"]:
                binding["value"] = value
                with self.assertRaises(ValueError):
                    module.validate(app, [{"id": "synthetic"}], "qualified")
            binding["value"] = original
            env.remove(binding)
            with self.assertRaises(ValueError):
                module.validate(app, [{"id": "synthetic"}], "qualified")
            env.append(binding)
        app["active_deployment"]["spec"]["jobs"] = [{"name": "unexpected"}]
        with self.assertRaises(ValueError):
            module.validate(app, [{"id": "synthetic"}], "qualified")

    def test_workflow_always_preflights_before_update(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/web-server-deploy.yml").read_text()
        preflight = '          python3 scripts/verify-state-cutover.py "$DO_APP_ID" "$GITHUB_SHA"'
        update = '          doctl apps update "$DO_APP_ID"'
        self.assertEqual(workflow.count(preflight), 1)
        self.assertLess(workflow.index(preflight), workflow.index(update))
        section = workflow[workflow.index('          python3 scripts/merge-do-app-spec.py'):workflow.index(update)]
        self.assertNotIn("          if ", section)
