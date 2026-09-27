"""Versioned template/regex compatibility and real hydration, isolated SQLite."""
import ast,json,os,re,sqlite3,sys,threading,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
STAGE=Path(os.environ.get('HOMER_R26_STAGE',str(ROOT/'output/mobile-r25/server')))
sys.path[:0]=[str(STAGE),'D:/网站/功能/AIXingYue-main/tools']
from community_workshop import CommunityStore,ensure_community_schema,_validate_work_payload
from card_version_workshop import ensure_card_version_schema
from card_extra_workshop import prepare_card_extra
from chat_mod_workshop import apply_locked_community_assets

class TemplateTests(unittest.TestCase):
 def setUp(self):
  self.conn=sqlite3.connect(':memory:');self.conn.row_factory=sqlite3.Row;self.lock=threading.RLock()
  self.conn.executescript('create table local_apps(id text);create table conversations(id text);')
  ensure_card_version_schema(self.conn,self.lock);ensure_community_schema(self.conn,self.lock)
  self.store=CommunityStore(self.conn,self.lock)
 def tearDown(self):self.conn.close()
 def make(self,kind):return self.store.create_work('owner','创作者',{'work_type':kind,'name':kind,'content':{'regex_scripts':[{'findRegex':'OPEN','replaceString':'<b>READY</b>','markdownOnly':True,'placement':[2]}]},'is_public':True})
 def test_old_and_new_list_together_but_keep_version_types(self):
  old=self.make('regex');new=self.make('ui_template')
  self.assertEqual({r['id'] for r in self.store.list_works('ui_template','mine','owner')},{old['id'],new['id']})
  self.assertEqual({r['id'] for r in self.store.list_works('regex','mine','owner')},{old['id'],new['id']})
  self.assertIsNotNone(self.store.versions.snapshot(old['current_version_id'],'regex',old['id']))
 def test_author_selection_hydrates_real_regex_without_duplicate_or_overwriting_card_rules(self):
  for kind in ['regex','ui_template']:
   work=self.make(kind)
   selected=prepare_card_extra(self.conn,self.lock,'owner',{'applied_ui_template_ids':[work['id']]})
   self.assertEqual(selected['applied_ui_template_version_ids'],[work['current_version_id']])
   selected['regex_scripts']=[{'id':'own','findRegex':'OWN','replaceString':'own'}]
   app={'extra_settings':selected};apply_locked_community_assets(self.conn,self.lock,app);apply_locked_community_assets(self.conn,self.lock,app)
   rules=app['extra_settings']['regex_scripts'];self.assertEqual(len(rules),2);self.assertTrue(rules[0]['markdownOnly']);self.assertEqual(rules[0]['replaceString'],'<b>READY</b>');self.assertEqual(rules[1]['id'],'own')
 def test_other_user_cannot_apply_unfavorited_private_asset_or_read_source(self):
  work=self.make('regex')
  with self.assertRaises(ValueError):prepare_card_extra(self.conn,self.lock,'other',{'applied_ui_template_ids':[work['id']]})
  self.assertNotIn('content',self.store.public_work(work,'other',detail=True))
 def test_template_regex_payload_validated_and_legacy_content_preserved(self):
  _validate_work_payload('ui_template','<body>legacy</body>')
  with self.assertRaises(ValueError):_validate_work_payload('ui_template',{'regex_scripts':[{'findRegex':2}]})


class LosslessRegexTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  tree=ast.parse((STAGE/'ai_fengyue_local_server.py').read_text(encoding='utf-8-sig'))
  names={'checked_regex_replacement','recover_legacy_regex_replacements','normalize_regex_scripts','normalize_full_regex_script','regex_script_to_sillytavern','split_silly_regex_pattern'}
  nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names]
  cls.scope={'re':re,'ROLE_CARD_REGEX_MAX_ENTRIES':500,'REGEX_REPLACE_MAX_BYTES':8*1024*1024,'_preset_bool':lambda value,default:default if value is None else bool(value)}
  exec(compile(ast.Module(body=nodes,type_ignores=[]),'<actual staged host regex>','exec'),cls.scope)
 def test_large_html_survives_normalize_projection_and_global_preset(self):
  html='```html\n<html><body>'+('界面代码'*250000)+'</body></html>\n```'
  rule={'id':'big','findRegex':'START','replaceString':html,'markdownOnly':True,'placement':[2]}
  normalized=self.scope['normalize_regex_scripts']([rule])[0]
  self.assertEqual(normalized['replace'],html)
  self.assertEqual(self.scope['regex_script_to_sillytavern'](normalized)['replaceString'],html)
  self.assertEqual(self.scope['normalize_full_regex_script'](rule)['replaceString'],html)
 def test_utf8_size_limit_rejects_instead_of_truncating(self):
  huge='界'*(3*1024*1024)
  for name in ('normalize_regex_scripts','normalize_full_regex_script','regex_script_to_sillytavern'):
   rule={'findRegex':'START','replaceString':huge}
   with self.assertRaisesRegex(ValueError,'8 MiB'):
    self.scope[name]([rule] if name=='normalize_regex_scripts' else rule)
 def test_old_truncation_recovers_from_same_snapshot_not_edits(self):
  full='x'*240000+'</body></html>\n```'
  rule={'id':'big','findRegex':'START','replaceString':full,'placement':[2]}
  saved=self.scope['normalize_regex_scripts']([rule])[0];saved['replace']=full[:240000];saved['enabled']=False
  extra={'sillytavern_card':{'data':{'extensions':{'regex_scripts':[rule]}}}}
  restored=self.scope['recover_legacy_regex_replacements']([saved],extra)
  self.assertEqual(restored[0]['replace'],full);self.assertFalse(restored[0]['enabled'])
  self.assertEqual(len(saved['replace']),240000,'Projection must not mutate saved history')
  for edited in ('edited','y'+full[1:240000]):
   current=dict(saved,replace=edited)
   self.assertEqual(self.scope['recover_legacy_regex_replacements']([current],extra),[current])
  extra['extensions']={'regex_scripts':[dict(rule,replaceString=full+'different')]}
  self.assertEqual(self.scope['recover_legacy_regex_replacements']([saved],extra),[saved],'Ambiguous originals must not overwrite saved content')

class GreetingSourceTests(unittest.TestCase):
 def test_start_greetings_keep_source_and_alternates_without_running_display_regex(self):
  tree=ast.parse((ROOT/'output/mobile-r25/server/ai_fengyue_local_server.py').read_text(encoding='utf-8-sig'))
  node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='chat_greetings_from_card')
  def source_stage(text,card,*,source_only=False):
   self.assertTrue(source_only,'Display regex belongs to the client, not stored chat source')
   return text
  scope={'split_silly_first_mes_greetings':lambda s:{'primary':s,'alternates':[]},
   'imported_opening_preface_from_notes':lambda _: '',
   'merge_alternate_greetings':lambda primary,*groups:[s for group in groups for s in group if s!=primary],
   'render_tavern_template':lambda text,*args,**kwargs:text,'_dedupe_text_key':lambda s:s.strip(),
   'apply_regex_scripts':source_stage}
  exec(compile(ast.Module(body=[node],type_ignores=[]),'<actual staged greeting builder>','exec'),scope)
  self.assertEqual(scope['chat_greetings_from_card']({'opening_statement':'LOADING...','alternate_greetings':['NEXT']}),['LOADING...','NEXT'])
 def test_source_stage_retains_plain_transform_rules_but_skips_display_prompt_and_other_roles(self):
  tree=ast.parse((ROOT/'output/mobile-r25/server/ai_fengyue_local_server.py').read_text(encoding='utf-8-sig'))
  node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='apply_regex_scripts')
  rules=[{'find':'START','replace':'DISPLAY','markdownOnly':True},{'find':'START','replace':'PROMPT','promptOnly':True},{'find':'START','replace':'USER','placement':[1]},{'find':'START','replace':'SOURCE','placement':[2]}]
  scope={'re':re,'enabled_regex_scripts':lambda _:rules,'expand_silly_regex_replacement':lambda text,match:text}
  exec(compile(ast.Module(body=[node],type_ignores=[]),'<actual staged source stage>','exec'),scope)
  self.assertEqual(scope['apply_regex_scripts']('START',{},source_only=True),'SOURCE')
  self.assertEqual(scope['apply_regex_scripts']('START',{}),'DISPLAY','Unrelated old callers retain their existing semantics')

if __name__=='__main__':unittest.main()
