import ast, copy, subprocess, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import urllib.error
import yaml
path=str(Path(__file__).with_name('charm-inspect-handoff.py'))
tree=ast.parse(Path(path).read_text(), filename=path)
selected=[n for n in tree.body if isinstance(n,(ast.Import,ast.ImportFrom,ast.FunctionDef)) or (isinstance(n,ast.Assign) and all(isinstance(t,ast.Name) for t in n.targets))]
ns={}
exec(compile(ast.Module(body=selected,type_ignores=[]),path,'exec'),ns)
REV='a'*40

def sample():
    return {'maintenance':{},'envs':[{'key':'GLOBAL','type':'SECRET','value':'EV[synthetic-global]'}],
            'services':[{'name':'api','github':{'repo':'CloudHub-Social/Charm','branch':'main','deploy_on_push':False},'envs':[
                {'key':'CHARM_WEB_SERVER_SPACES_BUCKET','value':'charm-web-server-sessions'},
                {'key':'CHARM_WEB_SERVER_SPACES_ENDPOINT','value':'https://tor1.digitaloceanspaces.com'},
                {'key':'CHARM_WEB_SERVER_STATE_BUCKET','value':'charm-api-state-production'},
                {'key':'CHARM_WEB_SERVER_SOURCE_SHA','value':'${_self.COMMIT_HASH}'},
                {'key':'CHARM_WEB_SERVER_EXPECTED_SOURCE_SHA','value':'old'},
                *[{'key':k,'type':'SECRET','value':'EV[synthetic]'} for k in (
                    'CHARM_WEB_SERVER_SPACES_ACCESS_KEY_ID','CHARM_WEB_SERVER_SPACES_SECRET_ACCESS_KEY',
                    'CHARM_WEB_SERVER_STATE_ACCESS_KEY_ID','CHARM_WEB_SERVER_STATE_SECRET_ACCESS_KEY')]]}]}

class Fixtures(unittest.TestCase):
    def test_unarchived_spec_and_all_secrets_preserved(self):
        a=sample();before=copy.deepcopy(a);out=ns['build_spec'](a,REV)
        self.assertEqual(a,before)
        self.assertIs(out['maintenance']['archive'],False)
        self.assertEqual(ns['secret_entries'](a),ns['secret_entries'](out))
        env={x['key']:x['value'] for x in out['services'][0]['envs']}
        self.assertEqual(env['CHARM_WEB_SERVER_INVENTORY_INSPECT_ONLY'],'1')
        self.assertEqual(env['CHARM_WEB_SERVER_EXPECTED_SOURCE_SHA'],REV)
    def test_retained_archive_states_and_restoration(self):
        for state in [True, False, 'absent', 'no-maintenance']:
            a=sample()
            if state == 'no-maintenance': del a['maintenance']
            elif state != 'absent': a['maintenance']['archive']=state
            before=copy.deepcopy(a)
            if state is True:
                with self.assertRaises(RuntimeError): ns['build_spec'](a,REV)
            out=ns['build_spec'](a,REV,allow_unarchive=state is True)
            self.assertIs(out['maintenance']['archive'],False)
            self.assertEqual(a,before)
            ns['require_reconciled_result'](before,copy.deepcopy(before),ns['CATEGORIES'][0])
            if state is True:
                retained=copy.deepcopy(before); retained['maintenance']['archive']=False
                with self.assertRaises(RuntimeError):
                    ns['require_reconciled_result'](before,retained,ns['CATEGORIES'][0])
    def test_malformed_maintenance_refused(self):
        for value in [None, False, [], 'invalid', {'archive': None}, {'archive': 'true'}, {'archive': 1}]:
            a=sample(); a['maintenance']=value
            with self.assertRaises(RuntimeError): ns['build_spec'](a,REV)
    def test_secret_wipe_refused(self):
        a=sample();a['services'][0]['envs'][-1]['value']=''
        with self.assertRaises(RuntimeError): ns['build_spec'](a,REV)
    def test_wrong_bucket_refused(self):
        a=sample();a['services'][0]['envs'][0]['value']='other'
        with self.assertRaises(RuntimeError): ns['build_spec'](a,REV)
    def test_duplicate_entry_refused(self):
        a=sample();a['services'][0]['envs'].append(a['services'][0]['envs'][0].copy())
        with self.assertRaises(RuntimeError): ns['build_spec'](a,REV)
    def test_unknown_or_enabled_auto_deploy_refused(self):
        for value in [None, True]:
            a=sample()
            if value is None:
                del a['services'][0]['github']['deploy_on_push']
            else:
                a['services'][0]['github']['deploy_on_push']=value
            with self.assertRaises(RuntimeError): ns['build_spec'](a,REV)
    def test_global_secret_drift_detectable(self):
        a=sample();b=copy.deepcopy(a);b['envs'][0]['value']='EV[changed]'
        self.assertNotEqual(ns['secret_entries'](a),ns['secret_entries'](b))
    def test_provider_identity_must_be_present_and_pinned(self):
        self.assertFalse(ns['candidate_has_identity']({},REV))
        self.assertFalse(ns['candidate_has_identity']({'services':[{'name':'api'}]},REV))
        self.assertFalse(ns['candidate_has_identity']({'services':[{'name':'api','source_commit_hash':'b'*40}]},REV))
        self.assertTrue(ns['candidate_has_identity']({'services':[{'name':'api','source_commit_hash':REV}]},REV))
    def test_only_immutable_pr_merge_and_workflow_identity_are_accepted(self):
        pr={'number':614,'merged':True,'merge_commit_sha':REV,
            'base':{'ref':'main','repo':{'full_name':'CloudHub-Social/Charm'}}}
        self.assertEqual(ns['release_identities'](REV,REV,pr),(REV,REV))
        with self.assertRaises(RuntimeError): ns['release_identities']('b'*40,'b'*40,pr)
        with self.assertRaises(RuntimeError): ns['release_identities'](REV,'b'*40,pr)
        wrong=copy.deepcopy(pr); wrong['number']=613
        with self.assertRaises(RuntimeError): ns['release_identities'](REV,REV,wrong)
        wrong=copy.deepcopy(pr); wrong['merge_commit_sha']=None
        with self.assertRaises(RuntimeError): ns['release_identities'](REV,REV,wrong)
        pr['merged']=False
        with self.assertRaises(RuntimeError): ns['release_identities'](REV,REV,pr)

    def test_success_requires_conclusive_category_and_original_spec(self):
        original=sample()
        for category in ns['CATEGORIES'][:-1]:
            ns['require_reconciled_result'](original,copy.deepcopy(original),category)
        for category in [None,'state inventory inspection unavailable','unknown']:
            with self.assertRaises(RuntimeError):
                ns['require_reconciled_result'](original,copy.deepcopy(original),category)
        retained=copy.deepcopy(original)
        retained['services'][0]['envs'].append({'key':'CHARM_WEB_SERVER_INVENTORY_INSPECT_ONLY','value':'1'})
        with self.assertRaises(RuntimeError):
            ns['require_reconciled_result'](original,retained,ns['CATEGORIES'][0])
        retained=copy.deepcopy(original); retained['maintenance']['archive']=False
        with self.assertRaises(RuntimeError):
            ns['require_reconciled_result'](original,retained,ns['CATEGORIES'][0])

    def test_transient_read_retries_without_retrying_denial_or_deadline(self):
        fake_time=SimpleNamespace(monotonic=lambda: 0,sleep=lambda _: None)
        read=Mock(side_effect=[urllib.error.URLError('synthetic'),{'deployment':{'phase':'BUILDING'}}])
        with patch.dict(ns,{'req':read,'time':fake_time}):
            self.assertEqual(ns['read_candidate_until']('synthetic','synthetic',60),{'phase':'BUILDING'})
        self.assertEqual(read.call_count,2)
        server_error=urllib.error.HTTPError('https://example.invalid',503,'unavailable',None,None)
        read=Mock(side_effect=[server_error,{'deployment':{'phase':'BUILDING'}}])
        with patch.dict(ns,{'req':read,'time':fake_time}):
            self.assertEqual(ns['read_candidate_until']('synthetic','synthetic',60),{'phase':'BUILDING'})
        self.assertEqual(read.call_count,2)
        for status in [403,429]:
            denied=Mock(side_effect=urllib.error.HTTPError('https://example.invalid',status,'denied',None,None))
            with patch.dict(ns,{'req':denied,'time':fake_time}):
                with self.assertRaises(urllib.error.HTTPError):
                    ns['read_candidate_until']('synthetic','synthetic',60)
            self.assertEqual(denied.call_count,1)
        expired=Mock(side_effect=urllib.error.URLError('synthetic'))
        with patch.dict(ns,{'req':expired,'time':SimpleNamespace(monotonic=lambda: 61,sleep=lambda _: None)}):
            with self.assertRaises(RuntimeError):
                ns['read_candidate_until']('synthetic','synthetic',60)
        self.assertEqual(expired.call_count,1)

    def test_workflow_requires_acknowledgments_and_all_three_job_outcomes(self):
        workflow=Path(__file__).resolve().parents[1]/'.github/workflows/charm-inspect-dispatch.yml'
        config=yaml.safe_load(workflow.read_text())
        jobs=config['jobs']
        validation=jobs['validate']['steps'][0]['run']
        valid={'TARGET_REF':'refs/heads/main','SOLE_WRITER':'true','BUDGET_HEADROOM':'true'}
        cases=[(valid,0)]
        for key,bad in [('TARGET_REF','refs/heads/other'),('TARGET_REF',''),('SOLE_WRITER','false'),('BUDGET_HEADROOM','false'),('SOLE_WRITER',''),('BUDGET_HEADROOM','')]:
            cases.append(({**valid,key:bad},1))
        for env,expected in cases:
            result=subprocess.run(['/bin/bash','-c',validation],env=env,capture_output=True)
            self.assertEqual(result.returncode,expected,env)
        self.assertEqual(jobs['r2_precheck']['needs'],'validate')
        self.assertEqual(set(jobs['r2_postcheck']['needs']),{'r2_precheck','inspect'})
        self.assertIn('always()',jobs['r2_postcheck']['if'])
        for name in ['r2_precheck','inspect']:
            condition=jobs[name]['if']
            self.assertIn('inputs.sole_writer_coordinated',condition)
            self.assertIn('inputs.budget_headroom_verified',condition)
        outcome=jobs['inspection_outcome']
        self.assertEqual(set(outcome['needs']),{'validate','r2_precheck','inspect','r2_postcheck'})
        self.assertEqual(outcome['if'],'always()')
        env_names={'VALIDATE_RESULT':'validate','PRECHECK_RESULT':'r2_precheck','INSPECT_RESULT':'inspect','POSTCHECK_RESULT':'r2_postcheck'}
        for variable,job in env_names.items():
            self.assertEqual(outcome['env'][variable], '${{ needs.'+job+'.result }}')
        command=outcome['steps'][0]['run']
        good={key:'success' for key in env_names}
        cases=[(good,0)]
        for key in env_names:
            for bad in ['skipped','failure','cancelled','']:
                cases.append(({**good,key:bad},1))
        for env,expected in cases:
            result=subprocess.run(['/bin/bash','-c',command],env=env,capture_output=True)
            self.assertEqual(result.returncode,expected,env)

    def test_workflow_unarchive_opt_in_reaches_handoff(self):
        workflow=Path(__file__).resolve().parents[1]/'.github/workflows/charm-inspect-dispatch.yml'
        config=yaml.safe_load(workflow.read_text())
        # YAML 1.1 parsers treat the GitHub Actions key "on" as True.
        dispatch=config.get('on',config.get(True))['workflow_dispatch']['inputs']
        opt_in=dispatch['allow_archived_retained_spec']
        self.assertEqual(opt_in['type'],'boolean')
        self.assertIs(opt_in['default'],False)
        inspect=config['jobs']['inspect']
        self.assertEqual(inspect['env']['CHARM_ALLOW_ARCHIVED_RETAINED_SPEC'],
                         '${{ inputs.allow_archived_retained_spec }}')
        self.assertTrue(any('python3 scripts/charm-inspect-handoff.py' in step.get('run','')
                            for step in inspect['steps']))
        main=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='main')
        assignments=[n for n in ast.walk(main) if isinstance(n,ast.Assign)]
        assignment=next(n for n in assignments if any(isinstance(t,ast.Name) and t.id=='opt_in' for t in n.targets))
        self.assertEqual(ast.unparse(assignment.value), "os.environ.get('CHARM_ALLOW_ARCHIVED_RETAINED_SPEC')")
        self.assertTrue(any(ast.unparse(n.test)=="opt_in not in ('true', 'false')"
                            for n in ast.walk(main) if isinstance(n,ast.If)))
        calls=[n for n in ast.walk(main) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='build_spec']
        self.assertEqual(len(calls),1)
        keyword=next(k for k in calls[0].keywords if k.arg=='allow_unarchive')
        self.assertEqual(ast.unparse(keyword.value), "opt_in == 'true'")

if __name__=='__main__': unittest.main()
