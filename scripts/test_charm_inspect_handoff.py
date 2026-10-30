import ast, copy, sys, unittest
from pathlib import Path
from unittest.mock import patch
path=str(Path(__file__).with_name('charm-inspect-handoff.py'))
tree=ast.parse(open(path).read(), filename=path)
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
    def test_archived_proposal_refused(self):
        a=sample();a['maintenance']['archive']=True
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

if __name__=='__main__': unittest.main()
