"""Private acceptance LAN service: pinned package hashes only, no directory browsing/API/auth data."""
import argparse
import hashlib
import json
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

parser=argparse.ArgumentParser();parser.add_argument('--bind',required=True);parser.add_argument('--port',type=int,default=8796)
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
manifest=json.loads((root/'frontend/app/assets/data/chatarchive-pack.json').read_text(encoding='utf-8'))
directory=root/'output/chatarchive-r359/人物素材包'
files={}
for item in manifest['packs']:
    if item['id']=='full':continue
    matches=list(directory.glob(f"*-{item['id']}.hcap"))
    if len(matches)!=1 or matches[0].stat().st_size!=item['bytes']:raise RuntimeError('PINNED_MEDIA_MISSING')
    with matches[0].open('rb') as stream:
        if hashlib.file_digest(stream,'sha256').hexdigest()!=item['sha256']:raise RuntimeError('PINNED_MEDIA_HASH')
    files['/'+item['sha256']+'.hcap']=matches[0]

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        target=files.get(self.path)
        if target is None:self.send_error(404);return
        self.send_response(200);self.send_header('Content-Type','application/octet-stream')
        self.send_header('Content-Length',str(target.stat().st_size));self.end_headers()
        try:
            with target.open('rb') as stream:
                while chunk:=stream.read(128*1024):self.wfile.write(chunk)
        except (BrokenPipeError,ConnectionResetError):pass
    def log_message(self,*args):pass

print(f'PRIVATE_MEDIA_READY {args.bind}:{args.port} packs={len(files)}',flush=True)
ThreadingHTTPServer((args.bind,args.port),Handler).serve_forever()
