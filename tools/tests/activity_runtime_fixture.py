"""Loopback services for the actual Android Activity, synthetic data only.

Run the isolated Node runtime on :8802 first. Build `.coldqa` with server
http://127.0.0.1:8817/. This is not a production provider or server test.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import json

ORIGIN = 'http://127.0.0.1:8817'
NODE = 'http://127.0.0.1:8802'
OWNER = 'activity-cold-synthetic-owner'
ROWS = [('qa-a', 'qa-card-a', 'QA archive A'), ('qa-b', 'qa-card-a', 'QA archive B'),
        ('qa-c', 'qa-card-c', 'QA archive C')]


def launch(conversation):
    row = next((row for row in ROWS if row[0] == conversation), ROWS[0])
    messages = [{'id': f'{row[0]}-{i}', 'role': 'assistant' if i % 2 == 0 else 'user',
                 'content': f'{row[0]}-R{i:04d}', 'created_at': 1720000000000 + i}
                for i in range(1101)]
    return {'user': {'id': OWNER, 'name': 'Synthetic QA', 'is_admin': False},
            'runtime': {'dialogue_api_base_url': ORIGIN + '/synthetic-provider', 'backend_base_url': ORIGIN},
            'launch': {'app_id': row[1], 'conversation_id': row[0], 'title': row[2],
                       'bridge_token': 'synthetic-only-not-credential', 'bridge_token_ttl_seconds': 900,
                       'card': {'spec': 'chara_card_v2', 'spec_version': '2.0', 'data': {
                           'name': row[2], 'description': 'Synthetic Activity acceptance',
                           'personality': '', 'scenario': '', 'first_mes': messages[0]['content'],
                           'mes_example': '', 'creator_notes': '', 'system_prompt': '',
                           'post_history_instructions': '', 'alternate_greetings': [], 'extensions': {},
                           'tags': [], 'creator': 'QA', 'character_version': '1'}},
                       'messages': messages, 'storage': {'protocol': 2, 'complete': True,
                                                        'version': row[0][-1] * 32,
                                                        'message_count': len(messages), 'unchanged': False}}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass

    def send(self, data, status=200, mime='application/json'):
        raw = data if isinstance(data, bytes) else json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        try: self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError): pass

    def body(self):
        if self.headers.get('Transfer-Encoding', '').lower() == 'chunked':
            chunks = []
            while True:
                size = int(self.rfile.readline().split(b';')[0], 16)
                if size == 0:
                    while self.rfile.readline().strip(): pass
                    return b''.join(chunks)
                chunks.append(self.rfile.read(size)); self.rfile.read(2)
        return self.rfile.read(int(self.headers.get('Content-Length', '0')))

    def dispatch(self):
        body = self.body() if self.command != 'GET' else None
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith('/module/dialogue/'):
            path = path[len('/module/dialogue'):]
        query = parse_qs(parsed.query)
        if path == '/qa/setup':
            page = ('<!doctype html><meta charset="utf-8"><script>'
                    "localStorage.setItem('ai_xingyue_logged_in','1');"
                    f"localStorage.setItem('ai_xingyue_user',JSON.stringify({json.dumps({'id': OWNER, 'name': 'Synthetic QA'})}));"
                    '</script><p id="qa-seeded">Synthetic setup only</p>')
            return self.send(page.encode(), mime='text/html')
        if path in ('/api/homer/session', '/console/api/web/dialogue/session'):
            return self.send(launch(query.get('conversation_id', ['qa-a'])[0]))
        if path.endswith('/profile'):
            return self.send({'data': {'id': OWNER, 'name': 'Synthetic QA', 'is_admin': False}})
        if path in ('/api/homer/conversations', '/console/api/web/conversations'):
            rows = [{'id': r[0], 'app_id': r[1], 'title': r[2], 'app_name': r[2],
                     'last_message': r[0] + '-R1100', 'updated_at': 1720000000000} for r in ROWS]
            return self.send({'list': rows} if path.startswith('/api/homer') else {'data': {'list': rows}})
        if path.endswith('/messages'):
            conv = path.split('/')[-2]
            session = launch(conv)['launch']
            return self.send({'data': {'conversation': {'id': conv, 'app_id': session['app_id']},
                                       'messages': session['messages']}})
        if path == '/api/homer/models':
            return self.send({'default_id': 'qa-model', 'list': [{'id': 'qa-model', 'name': 'QA model', 'enabled': True}]})
        if path == '/api/homer/regex': return self.send({'revision': 'qa-v1', 'scripts': []})
        if path == '/console/api/web/social/bootstrap':
            return self.send({'data': {'available': True, 'consented': True, 'permissions': {'can_publish': True}}})
        if path.startswith('/console/api/web/social/'):
            return self.send({'data': {'list': [], 'cursor': '', 'has_more': False}})
        if path == '/api/homer/runtime-state': return self.send({'extension_settings': {}, 'variables': {}})
        if path == '/api/homer/sync': return self.send({'ok': True})
        if path.startswith('/synthetic-provider') or path.endswith('/chat-completions/generate'):
            return self.send({'error': {'code': 'QA-NO-GENERATION', 'message': 'Synthetic benchmark never generates'}}, 503)
        if path.startswith('/api/homer/'):
            return self.send({'list': [], 'ok': True})
        if path.startswith('/console/') or path.startswith('/admin/') or path == '/download/release.json':
            return self.send({'data': {}})
        if path == '/css/user.css': return self.send(b'/* synthetic profile */', mime='text/css')
        # Only the private runtime receives framework API requests. Immutable
        # resources continue to be resolved by the product's APK interceptor.
        target = NODE + path + ('?' + parsed.query if parsed.query else '')
        headers = {key: value for key, value in self.headers.items()
                   if key.lower() not in ('host', 'content-length', 'transfer-encoding', 'connection', 'accept-encoding')}
        try:
            response = urlopen(Request(target, data=body, headers=headers, method=self.command), timeout=20)
        except HTTPError as error:
            response = error
        with response:
            raw = response.read(); mime = response.headers.get('Content-Type', '').split(';')[0]
            if path == '/api/settings/get' and response.status == 200:
                value = json.loads(raw); settings = json.loads(value['settings'])
                settings['firstRun'] = False; value['settings'] = json.dumps(settings)
                return self.send(value)
            return self.send(raw, response.status, mime= mime or 'application/octet-stream')

    do_GET = dispatch
    do_POST = dispatch


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 8817), Handler).serve_forever()
