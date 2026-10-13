"""Isolated deletion fixture, real product assets, no credentials or user data."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse
import json, mimetypes, time
ROOT = Path(__file__).resolve().parents[2]
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def send(self, data, status=200, mime='application/json'):
        body = json.dumps(data).encode() if mime=='application/json' else data
        self.send_response(status); self.send_header('Content-Type', mime); self.send_header('Cache-Control', 'no-store'); self.send_header('Content-Length', str(len(body))); self.end_headers()
        try: self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError): pass
    def do_GET(self):
        p=urlparse(self.path).path
        if p=='/console/api/web/conversations':
            return self.send({'data': {'list': [{'id':f'qa-{i}', 'app_id':'qa-card', 'app_name':f'验收会话 {i}', 'last_message':'隔离测试存档，不含账号数据', 'updated_at':i+1} for i in range(8)]}})
        if p=='/console/api/public/site-settings':return self.send({'data':{}})
        if p.endswith('/profile'):return self.send({'data':{'id':'qa-delete-owner','name':'删除验收'}})
        if p.endswith('/points'):return self.send({'points':0})
        if '/api/' in p:return self.send({'data':{}})
        base=ROOT/'sillytavern-runtime/public' if p.startswith(('/scripts/','/module/dialogue/')) else ROOT/'frontend'
        relative=p.removeprefix('/module/dialogue/') if p.startswith('/module/dialogue/') else p.lstrip('/')
        path=(base/relative).resolve()
        if not path.is_relative_to(base.resolve()) or not path.is_file():return self.send({'error':'fixture route unavailable'},404)
        mime=mimetypes.guess_type(path)[0] or 'application/octet-stream'
        if path.suffix in ['.js','.mjs']:mime='text/javascript'
        return self.send(path.read_bytes(),mime=mime)
    def do_POST(self):
        size=int(self.headers.get('Content-Length','0')); self.rfile.read(size)
        if self.path.endswith('/delete'):
            # Deliberately slower than UI acceptance. A stale list still returns
            # all records, verifying markers instead of optimistic list mutation.
            time.sleep(10)
            return self.send({'data':{'deleted':True}})
        return self.send({'data':{}})
if __name__=='__main__':ThreadingHTTPServer(('127.0.0.1',8804),Handler).serve_forever()
