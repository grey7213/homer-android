"""Execute the patched public catalog method in isolation, without server startup."""
import ast
import textwrap
import unittest
from pathlib import Path
from types import SimpleNamespace
from build_model_catalog_patch import transform

SOURCE=Path('C:/CodexWork/AIXingYue-upstream-20260918/AIXingYue-main/tools/ai_fengyue_local_server.py')

class PublicCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source=transform(SOURCE.read_text(encoding='utf-8-sig'))
        method=next(n for n in ast.walk(ast.parse(source)) if isinstance(n,ast.FunctionDef) and n.name=='public_model_presets')
        namespace={
            'split_model_names':lambda v:v if isinstance(v,list) else [v] if v else [],
            'model_config_for_preset':lambda p,m:{'display_name':m,'pricing':{'input_price':1}},
            'normalize_model_pricing':lambda v:v,
            'model_charge_points':lambda p:1,
            'model_price_label':lambda p:'1 积分',
            'model_selection_id':lambda n,m:f'{n}::{m}',
        }
        exec(compile(textwrap.dedent(ast.get_source_segment(source,method)),'public_model_presets','exec'),namespace)
        cls.method=staticmethod(namespace['public_model_presets'])

    def catalog(self,nodes,default='node-0'):
        def presets(include_secrets):
            self.assertFalse(include_secrets)
            return nodes,default
        return self.method(SimpleNamespace(llm_presets=presets))

    def test_same_names_in_three_groups_and_no_private_fields(self):
        nodes=[{'id':f'node-{n}','name':f'分组 {n}','enabled':True,'model':'m0','models':[f'm{i}' for i in range(41)],'api_key':'not-a-credential','base_url':'https://invalid.example'} for n in range(3)]
        result=self.catalog(nodes)
        self.assertEqual(result['total'],123)
        self.assertEqual(len({m['id'] for m in result['list']}),123)
        self.assertEqual({m['group_name'] for m in result['list']},{'分组 0','分组 1','分组 2'})
        self.assertEqual(result['default_id'],'node-0::m0')
        for model in result['list']:
            self.assertNotIn('api_key',model)
            self.assertNotIn('base_url',model)

    def test_disabled_only_does_not_leak_as_fallback(self):
        self.assertEqual(self.catalog([{'id':'node-0','name':'停用','enabled':False,'models':['m0']}]),{'list':[],'default_id':'','total':0})

    def test_disabled_default_and_duplicate_within_node(self):
        result=self.catalog([{'id':'node-0','enabled':False,'models':['m0']},{'id':'node-1','name':'可用','enabled':True,'model':'m0','models':['m0','m0','m1']}])
        self.assertEqual(result['total'],2)
        self.assertEqual(result['default_id'],'node-1::m0')

    def test_empty(self):
        self.assertEqual(self.catalog([]),{'list':[],'default_id':'','total':0})

if __name__=='__main__':unittest.main(verbosity=2)
