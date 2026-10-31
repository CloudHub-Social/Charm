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
NOW=ns['datetime'].datetime(2026,10,31,12,tzinfo=ns['datetime'].timezone.utc).timestamp()
OBS={'app':ns['APP'],'component':'api','revision':REV,'observed_at':'2026-10-31T12:00:00Z','off':True,'run_id':'123','run_attempt':'1','actor':'operator'}

def build(original, revision, **kwargs):
    return ns['build_spec'](original,revision,attestation=copy.deepcopy(OBS),run_id='123',actor='operator',now=NOW,**kwargs)

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
        a=sample();before=copy.deepcopy(a);out=build(a,REV)
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
                with self.assertRaises(RuntimeError): build(a,REV)
            out=build(a,REV,allow_unarchive=state is True)
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
            with self.assertRaises(RuntimeError): build(a,REV)
    def test_secret_wipe_refused(self):
        a=sample();a['services'][0]['envs'][-1]['value']=''
        with self.assertRaises(RuntimeError): build(a,REV)
    def test_wrong_bucket_refused(self):
        a=sample();a['services'][0]['envs'][0]['value']='other'
        with self.assertRaises(RuntimeError): build(a,REV)
    def test_duplicate_entry_refused(self):
        a=sample();a['services'][0]['envs'].append(a['services'][0]['envs'][0].copy())
        with self.assertRaises(RuntimeError): build(a,REV)
    def test_unknown_or_enabled_auto_deploy_refused(self):
        for value in [None, True, 'false', 0]:
            a=sample()
            a['services'][0]['github']['deploy_on_push']=value
            with self.assertRaises(RuntimeError): build(a,REV)
        a=sample(); del a['services'][0]['github']['deploy_on_push']
        build(a,REV)
        with self.assertRaises(RuntimeError): ns['build_spec'](a,REV)

    def test_off_attestation_fails_closed_on_time_and_identity(self):
        source=sample(); del source['services'][0]['github']['deploy_on_push']
        validate=ns['validate_off_attestation']
        validate(source,REV,copy.deepcopy(OBS),'123','operator',NOW)
        validate(source,REV,copy.deepcopy(OBS),'123','operator',NOW+300)
        for now in [NOW-1,NOW+301]:
            with self.assertRaises(RuntimeError): validate(source,REV,copy.deepcopy(OBS),'123','operator',now)
        for key,value in [('app','other'),('component','other'),('revision','b'*40),('off',False),
                          ('run_id','999'),('run_attempt','2'),('actor','other'),('observed_at','invalid')]:
            bad=copy.deepcopy(OBS); bad[key]=value
            with self.assertRaises(RuntimeError): validate(source,REV,bad,'123','operator',NOW)
        for key in OBS:
            bad=copy.deepcopy(OBS); del bad[key]
            with self.assertRaises(RuntimeError): validate(source,REV,bad,'123','operator',NOW)
        with self.assertRaises(RuntimeError): validate(source,REV,copy.deepcopy(OBS),'','operator',NOW)
        with self.assertRaises(RuntimeError): validate(source,REV,copy.deepcopy(OBS),'123','',NOW)

    def test_off_attestation_rejects_conflicting_sources(self):
        for kind in ['git','gitlab','bitbucket','image']:
            for value in [{}, {'deploy_on_push':True}, 'malformed']:
                source=sample(); source['services'][0][kind]=value
                with self.assertRaises(RuntimeError):
                    ns['validate_off_attestation'](source,REV,copy.deepcopy(OBS),'123','operator',NOW)
            source=sample(); source['services'][0][kind]=None
            ns['validate_off_attestation'](source,REV,copy.deepcopy(OBS),'123','operator',NOW)

    def test_final_check_precedes_update_and_revalidates_freshness(self):
        main=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='main')
        lines=Path(path).read_text().splitlines()
        check=next(n.lineno for n in ast.walk(main) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='validate_off_attestation')
        update=next(i for i,line in enumerate(lines,1) if "PHASE = 'single update'" in line)
        self.assertLess(check,update)
        source=sample(); del source['services'][0]['github']['deploy_on_push']
        ns['validate_off_attestation'](source,REV,copy.deepcopy(OBS),'123','operator',NOW)
        with self.assertRaises(RuntimeError):
            ns['validate_off_attestation'](source,REV,copy.deepcopy(OBS),'123','operator',NOW+301)

    def test_separate_dispatch_replay_is_not_technically_prevented(self):
        # Run IDs are assigned after dispatch; the ID is a receipt, not proof
        # the human observation was made uniquely for that execution.
        source=sample(); del source['services'][0]['github']['deploy_on_push']
        replay={**OBS,'run_id':'456'}
        ns['validate_off_attestation'](source,REV,replay,'456','operator',NOW)

    def test_main_rejects_expiry_or_drift_before_provider_update(self):
        base={'ref':'main','repo':{'full_name':'CloudHub-Social/Charm'}}
        original={'number':614,'merged':True,'merge_commit_sha':ns['ORIGINAL_DIAGNOSTIC_SHA'],'base':base}
        successor={'number':999,'merged':True,'merge_commit_sha':REV,'base':base}
        lineage={'status':'ahead','merge_base_commit':{'sha':ns['ORIGINAL_DIAGNOSTIC_SHA']}}
        spec=sample(); spec['services'][0].update({'instance_count':1,'instance_size_slug':ns['SIZE']})
        del spec['services'][0]['github']['deploy_on_push']
        active={'id':'baseline','phase':'ACTIVE','spec':{'maintenance':{'archive':True}}}
        env={'GITHUB_ACTIONS':'true','GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':'refs/heads/main',
             'GITHUB_SHA':REV,'GITHUB_WORKFLOW_SHA':REV,'GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1',
             'GITHUB_ACTOR':'operator','DIGITALOCEAN_ACCESS_TOKEN':'synthetic',
             'CHARM_R2_PREFLIGHT':'empty','CHARM_BUDGET_HEADROOM':'confirmed',
             'CHARM_ALLOW_ARCHIVED_RETAINED_SPEC':'false','CHARM_OBSERVED_APP_ID':ns['APP'],
             'CHARM_OBSERVED_COMPONENT':'api','CHARM_OBSERVED_REVISION':REV,
             'CHARM_OBSERVED_AT_UTC':OBS['observed_at'],'CHARM_OBSERVED_AUTODEPLOY_OFF':'true'}
        for reason in ['expiry','drift','raw_true','conflicting_source','wrong_revision','missing_observation']:
            initial=copy.deepcopy(spec)
            attempt_env=env.copy()
            if reason=='raw_true': initial['services'][0]['github']['deploy_on_push']=True
            if reason=='conflicting_source': initial['services'][0]['image']={'deploy_on_push':True}
            if reason=='wrong_revision': attempt_env['CHARM_OBSERVED_REVISION']='b'*40
            if reason=='missing_observation': attempt_env.pop('CHARM_OBSERVED_AT_UTC')
            changed=copy.deepcopy(spec)
            if reason=='drift': changed['envs'][0]['value']='EV[changed]'
            app_state=Mock(side_effect=[({'spec':initial},copy.deepcopy(active),[]),
                                        ({'spec':changed},copy.deepcopy(active),[])])
            fake_time=SimpleNamespace(time=Mock(side_effect=[NOW,NOW+301] if reason=='expiry' else [NOW]))
            popen=Mock(side_effect=AssertionError('provider update must not run'))
            substitutions={'SUCCESSOR_PR':999,'req':Mock(side_effect=[original,successor,lineage]),
                           'source_revision':Mock(),'app_state':app_state,'time':fake_time}
            with patch.dict(ns,substitutions), patch.dict(ns['os'].environ,attempt_env,clear=True), \
                 patch.object(ns['sys'],'argv',['handoff',REV,'--execute','--coordinated-sole-writer']), \
                 patch.object(ns['subprocess'],'Popen',popen):
                with self.assertRaises(RuntimeError): ns['main']()
            popen.assert_not_called()

    def test_workflow_attestation_inputs_are_bound_to_inspect_job(self):
        workflow=Path(__file__).resolve().parents[1]/'.github/workflows/charm-inspect-dispatch.yml'
        config=yaml.safe_load(workflow.read_text())
        inputs=config.get('on',config.get(True))['workflow_dispatch']['inputs']
        self.assertIs(inputs['observed_autodeploy_off']['default'],False)
        inspect=config['jobs']['inspect']
        for key,name in [('CHARM_OBSERVED_APP_ID','observed_app_id'),
                         ('CHARM_OBSERVED_COMPONENT','observed_component'),
                         ('CHARM_OBSERVED_REVISION','observed_revision'),
                         ('CHARM_OBSERVED_AT_UTC','observed_at_utc'),
                         ('CHARM_OBSERVED_AUTODEPLOY_OFF','observed_autodeploy_off')]:
            self.assertEqual(inspect['env'][key],'${{ inputs.'+name+' }}')
    def test_global_secret_drift_detectable(self):
        a=sample();b=copy.deepcopy(a);b['envs'][0]['value']='EV[changed]'
        self.assertNotEqual(ns['secret_entries'](a),ns['secret_entries'](b))
    def test_provider_identity_must_be_present_and_pinned(self):
        self.assertFalse(ns['candidate_has_identity']({},REV))
        self.assertFalse(ns['candidate_has_identity']({'services':[{'name':'api'}]},REV))
        self.assertFalse(ns['candidate_has_identity']({'services':[{'name':'api','source_commit_hash':'b'*40}]},REV))
        self.assertTrue(ns['candidate_has_identity']({'services':[{'name':'api','source_commit_hash':REV}]},REV))
    def test_only_immutable_pr_merge_and_workflow_identity_are_accepted(self):
        base={'ref':'main','repo':{'full_name':'CloudHub-Social/Charm'}}
        original={'number':614,'merged':True,'merge_commit_sha':ns['ORIGINAL_DIAGNOSTIC_SHA'],'base':base}
        successor={'number':999,'merged':True,'merge_commit_sha':REV,'base':base}
        lineage={'status':'ahead','merge_base_commit':{'sha':ns['ORIGINAL_DIAGNOSTIC_SHA']}}
        with self.assertRaises(RuntimeError): ns['release_identities'](REV,REV,original,successor,lineage)
        with patch.dict(ns,{'SUCCESSOR_PR':999}):
            self.assertEqual(ns['release_identities'](REV,REV,original,successor,lineage),(REV,REV))
            with self.assertRaises(RuntimeError): ns['release_identities']('b'*40,'b'*40,original,successor,lineage)
            with self.assertRaises(RuntimeError): ns['release_identities'](REV,'b'*40,original,successor,lineage)
            for key,value in [('number',998),('merge_commit_sha',None),('merged',False)]:
                wrong=copy.deepcopy(successor); wrong[key]=value
                with self.assertRaises(RuntimeError): ns['release_identities'](REV,REV,original,wrong,lineage)
            wrong=copy.deepcopy(original); wrong['merge_commit_sha']='b'*40
            with self.assertRaises(RuntimeError): ns['release_identities'](REV,REV,wrong,successor,lineage)
            wrong={'status':'ahead','merge_base_commit':{'sha':'b'*40}}
            with self.assertRaises(RuntimeError): ns['release_identities'](REV,REV,original,successor,wrong)

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

    def test_readonly_precheck_has_only_main_scoped_gets(self):
        path=Path(__file__).resolve().parents[1]/'.github/workflows/charm-readonly-precheck.yml'
        config=yaml.safe_load(path.read_text())
        jobs=config['jobs']
        self.assertEqual(set(jobs),{'validate','provider','destination'})
        self.assertEqual(config['permissions'],{'contents':'read'})
        self.assertEqual(jobs['validate']['env']['TARGET_REF'],'${{ github.ref }}')
        cmd=jobs['validate']['steps'][0]['run']
        for ref,expected in [('refs/heads/main',0),('refs/heads/other',1),('',1)]:
            self.assertEqual(subprocess.run(['/bin/bash','-c',cmd],env={'TARGET_REF':ref},capture_output=True).returncode,expected)
        for name in ['provider','destination']:
            job=jobs[name]
            self.assertEqual(job['needs'],'validate')
            self.assertEqual(job['if'],"github.ref == 'refs/heads/main'")
            self.assertEqual(len(job['steps']),1)
            run=job['steps'][0]['run']
            self.assertIn("method='GET'",run)
            for prohibited in ['apps update','/cancel',"method='POST'","method='PUT'",'charm-inspect-handoff.py']:
                self.assertNotIn(prohibited,run)
        self.assertIn("else 'unknown'",jobs['provider']['steps'][0]['run'])

if __name__=='__main__': unittest.main()
