"""Real parser/handler/SQLite debit methods; synthetic upstream and no credentials."""
import ast
import contextlib
import io
import json
import os
from pathlib import Path
import socket
import sqlite3
import sys
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request
import uuid

SOURCE = Path(os.environ['HOMER_BACKEND_SOURCE'])
sys.path.insert(0, str(SOURCE.parent))
from homer_generation import validate_upstream_event, require_generated_text, settle_delivered_generation, generation_error
TREE = ast.parse(SOURCE.read_text(encoding='utf-8-sig'))


def functions(names):
    return [node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name in names]


class BillingTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''create table users(id text,free_points int,reward_points int,paid_points int,points int,updated_at int);
            insert into users values('u',2,3,95,100,0);
            create table user_events(user_id text,event_type text,summary text,payload_json text,created_at int);''')
        env = dict(sqlite3=sqlite3, now_ms=lambda:int(time.time()*1000))
        cls = next(n for n in TREE.body if isinstance(n, ast.ClassDef) and n.name == 'Store')
        for node in cls.body:
            if isinstance(node, ast.FunctionDef) and node.name in {'credit_balance','_spend_credit_points_locked','require_credit_points'}:
                exec(compile(ast.Module(body=[node], type_ignores=[]), str(SOURCE),'exec'),env)
        Store = type('Store', (), {name:env[name] for name in ('credit_balance','_spend_credit_points_locked','require_credit_points')})
        self.store = Store(); self.store.conn=self.db; self.store.lock=threading.RLock()
        self.store.get_user_by_id=lambda user:self.db.execute('select * from users where id=?',(user,)).fetchone()
        self.scope = dict(json=json, Request=Request, HTTPError=HTTPError, socket=socket, time=time, uuid=uuid,
            validate_upstream_event=validate_upstream_event, require_generated_text=require_generated_text,
            settle_delivered_generation=settle_delivered_generation, generation_error=generation_error,
            json_bytes=lambda value:json.dumps(value).encode(), extract_token_usage=lambda value:{},
            merge_token_usage=lambda a,b:a, estimate_text_tokens=lambda text:1, log=lambda *args:None,
            normalize_model_pricing=lambda p:p, model_charge_points=lambda *args:7,
            _bounded_int=lambda *args:1024, sillytavern_bridge_claims=lambda value:{'user_id':'u'},
            GENERATION_LIMITER=type('Limiter',(),{'acquire':lambda *args:contextlib.nullcontext()})())
        exec(compile(ast.Module(body=functions({'extract_upstream_chat_answer','extract_sse_answer','extract_stream_delta',
            '_stream_event_is_terminal','sillytavern_bridge_completion','stream_sillytavern_bridge_completion'}),type_ignores=[]),str(SOURCE),'exec'),self.scope)
        handler = next(n for n in TREE.body if isinstance(n,ast.ClassDef) and n.name=='Handler')
        method=next(n for n in handler.body if isinstance(n,ast.FunctionDef) and n.name=='handle_sillytavern_chat_completions')
        exec(compile(ast.Module(body=[method],type_ignores=[]),str(SOURCE),'exec'),self.scope)

    def tearDown(self): self.db.close()
    def balance(self): return tuple(self.db.execute('select free_points,reward_points,paid_points,points from users').fetchone())
    def cost_events(self): return self.db.execute('select count(*) from user_events').fetchone()[0]

    def invoke(self, stream, payload, write_failure=False):
        info={'user_id':'u','app_id':'card','conversation_id':'c','model':'model-a','endpoint':'http://127.0.0.1/test',
              'payload':{},'headers':{},'pricing':{},'input_tokens_estimate':1}
        self.scope['prepare_sillytavern_bridge_generation']=lambda *args:info
        def upstream(*args,**kwargs):
            if isinstance(payload,Exception): raise payload
            return io.BytesIO(payload)
        self.scope['urlopen']=upstream
        results=[]
        class Output(io.BytesIO):
            def write(self, data):
                if write_failure and (b'[DONE]' in data or not stream): raise BrokenPipeError()
                return super().write(data)
        h=type('Handler',(),{})(); h.store=self.store;h.headers={};h.command='POST';h.wfile=Output()
        h.client_ip=lambda:'127.0.0.1'; h.send_sse_headers=lambda status:None
        def send(status, data):
            if write_failure and status==200: raise BrokenPipeError()
            results.append((status,data))
        h.send_json=send
        self.scope['handle_sillytavern_chat_completions'](h,{'stream':stream})
        return results,h.wfile.getvalue()

    def test_failed_responses_never_debit(self):
        cases=[b'{"error":{"message":"busy"}}',b'{"code":503,"message":"busy"}',b'{"message":"busy"}',
               b'{"choices":[{"message":{"content":"   "}}]}',b'not json',HTTPError('local',429,'busy',{},None),TimeoutError()]
        for payload in cases:
            with self.subTest(payload=type(payload).__name__):
                self.invoke(False,payload); self.assertEqual(self.balance(),(2,3,95,100));self.assertEqual(self.cost_events(),0)

    def test_stream_errors_empty_partial_and_early_eof_never_debit(self):
        token=b'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
        terminal=b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        for payload in [b'data: [DONE]\n\n',token,token+b'data: {"error":{"message":"busy"}}\n\ndata: [DONE]\n\n',
                        token+terminal+b'data: {"type":"error","error":"busy"}\n\n',
                        b'data: {"choices":[{"delta":{"content":"   "}}]}\n\ndata: [DONE]\n\n',
                        token+b'data: malformed\n\ndata: [DONE]\n\n']:
            with self.subTest(size=len(payload)):
                self.invoke(True,payload);self.assertEqual(self.balance(),(2,3,95,100));self.assertEqual(self.cost_events(),0)

    def test_success_charged_once_and_final_write_failure_rolled_back(self):
        for stream in (False,True):
            payload=b'{"choices":[{"message":{"content":"reply"}}]}' if not stream else b'data: {"choices":[{"delta":{"content":"reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
            self.invoke(stream,payload,write_failure=True)
            self.assertEqual(self.balance(),(2,3,95,100)); self.assertEqual(self.cost_events(),0)
        self.invoke(True,payload)
        self.assertEqual(self.balance(),(0,0,93,93)); self.assertEqual(self.cost_events(),1)
        self.invoke(False,b'{"choices":[{"message":{"content":"reply"}}]}')
        self.assertEqual(self.balance(),(0,0,86,86)); self.assertEqual(self.cost_events(),2)

    def test_auth_balance_are_not_provider_errors(self):
        for code in (401,402,403): self.assertIn(str(code),generation_error(code)['error']['code'])

    def test_simultaneous_settlements_cannot_overspend(self):
        failures=[]
        def pay():
            try:settle_delivered_generation(self.store,'u',60,{},lambda charge:None)
            except ValueError:failures.append(True)
        threads=[threading.Thread(target=pay) for _ in range(2)]
        for t in threads:t.start()
        for t in threads:t.join()
        self.assertEqual(self.balance()[-1],40);self.assertEqual(self.cost_events(),1);self.assertEqual(len(failures),1)

if __name__=='__main__':unittest.main()
