"""Loopback-only acceptance fixture. No account, production API or original game assets."""
import argparse
import base64
import struct
import threading
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, unquote

ROOT = Path(__file__).resolve().parents[2] / "frontend"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4x8AAAAASUVORK5CYII=")
# Original synthetic PCM silence, solely for playback/cancellation wiring QA.
PCM = bytes(3200)
WAV = struct.pack('<4sI4s4sIHHIIHH4sI', b'RIFF', 36 + len(PCM), b'WAVE', b'fmt ', 16, 1, 1, 8000, 16000, 2, 16, b'data', len(PCM)) + PCM
FIXTURE = r'''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>合成剧情验收</title><style>body{margin:0;font-family:system-ui;background:#f5f4f7}header{height:62px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;box-sizing:border-box}body[data-theme=dark]{background:#17171b;color:#ededf1}header button{font:inherit;min-height:44px}#normal{padding:16px}</style><body><header><button>原会话菜单</button><span>合成数据验收</span><button>原会话设置</button></header><div id="normal">普通会话宿主占位；此页不连接正式账号</div><div id="reader"></div><script type="module">
import { mountVisualNovel } from '/app/assets/js/visual-novel-runtime.mjs';
import { createVisualNovelServices } from '/app/assets/js/visual-novel-services.mjs';
import { buildTimeline, anchorFor, createPresentationStore } from '/app/assets/js/visual-novel-core.mjs';
import { createStoryStore } from '/app/assets/js/visual-novel-story-store.mjs';
let params=new URLSearchParams(location.search);document.body.dataset.theme=params.get('theme')||'light';
const scope={owner:params.get('owner')||'synthetic-owner',appId:'synthetic-role',conversationId:params.get('conversation')||'synthetic-story'};
let valid=true;
const calls=[];
const makeMessages=()=>[
 {id:'opening',name:'合成角色',mes:'[背景:海边]\n[立绘:日常]\n清晨的海风吹过窗边。\n\n她转过身，向你挥了挥手。\n\n“今天想去哪里？”'},
];
let messages=makeMessages();
const stories=createStoryStore();
const capture=(name,cursor)=>({id:crypto.randomUUID(),name,messages:JSON.parse(JSON.stringify(messages)),metadata:{fixture:true},variables:{storyTurn:1},extensionSettings:{fixture:true},cursor,createdAt:Date.now()});
if(params.get('choices')==='1')messages=[{id:'choice-page',name:'合成角色',mes:'请选择你的回应。\n```choices\n[{"id":"yes","label":"一起散步","text":"我们一起去散步吧。"},{"id":"stay","label":"留在这里","text":"我们留在这里聊聊吧。"}]\n```'}];
if(params.get('empty')==='1')messages=[];
const services=createVisualNovelServices({scope,isCurrent:()=>valid,apiClient:{
 imageChat:async(payload,{signal})=>{calls.push({kind:'cg',payload});return await fetch('/synthetic/image-result',{method:'POST',body:JSON.stringify(payload),signal}).then(r=>r.json())},
 synthesizeTts:async(payload,{signal})=>{calls.push({kind:'tts',payload});return await fetch('/synthetic/tts-result',{method:'POST',body:JSON.stringify(payload),signal}).then(r=>r.json())}
}});
const reader=await mountVisualNovel({root:document.querySelector('#reader'),scope,isCurrent:()=>valid,
 card:{name:'合成角色',avatar:'/synthetic/image.png',media_assets:[]},messages,services,
 actions:{submit:async text=>{calls.push({kind:'submit',text});await new Promise(resolve=>setTimeout(resolve,80));},continue:async()=>{calls.push({kind:'continue'})},stop:async()=>{calls.push({kind:'stop'})},settings:async panel=>{calls.push({kind:'settings',panel})},exit:async()=>{calls.push({kind:'exit'})},
 saveStory:async({name,cursor})=>stories.save(scope,capture(name,cursor)),listStories:()=>stories.list(scope),
 loadStory:async id=>{const saved=await stories.get(scope,id);if(!saved||!confirm('合成宿主：备份并恢复？'))return false;await stories.save(scope,capture('合成自动备份',anchorFor(reader.timeline[reader.index])));messages=saved.messages;reader.update(messages);return saved},
 deleteStory:async id=>confirm('合成宿主：删除本机命名存档？')?stories.delete(scope,id):false}
});
window.fixture={reader,scope,calls,services,stories,buildTimeline,anchorFor,createPresentationStore,
 update:value=>{messages=value;reader.update(value)},invalidate:()=>{valid=false},
 destroy:()=>{reader.destroy();document.querySelector('#reader').remove()},
 large:()=>Array.from({length:1101},(_,i)=>({id:'m-'+i,name:'合成角色',is_user:i%7===0,mes:'第 '+i+' 条合成剧情。'+('风吹过街道，角色继续讲述过去的经历。'.repeat(16))+'\n\n下一段依旧完整保留。'}))};
window.fixtureReady=true;
window.addEventListener('pagehide',()=>stories.close(),{once:true});
</script></body></html>'''


class Handler(SimpleHTTPRequestHandler):
    # Use explicit lengths and keepalive like the production transport.
    protocol_version = 'HTTP/1.1'

    def end_headers(self):
        # These files stand in for APK-bundled assets. A fresh browser context
        # receives current bytes; later offline in-document remounts must not
        # depend on SimpleHTTPServer's last-modified heuristic (zero lifetime
        # for freshly edited CSS). APIs/media retain their own test semantics.
        if urlsplit(self.path).path.startswith(('/app/assets/', '/assets/')):
            self.send_header('Cache-Control', 'public, max-age=3600')
        super().end_headers()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *_args):
        pass

    def send_bytes(self, body, content_type):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/fixture':
            return self.send_bytes(FIXTURE.encode('utf-8'), 'text/html; charset=utf-8')
        if path == '/game-fixture':
            body = Path(__file__).with_name('chatarchive_game_fixture.html').read_bytes()
            return self.send_bytes(body, 'text/html; charset=utf-8')
        prefix = '/media-cache/card-assets/ready/archive-local-1111/'
        if path.startswith(prefix) and getattr(self.server, 'archive_pack', None):
            name = unquote(path[len(prefix):])
            if name.startswith('/') or any(part in ['', '.', '..'] for part in name.split('/')):
                return self.send_error(404)
            try:
                with zipfile.ZipFile(self.server.archive_pack) as media:
                    body = media.read(name)
                suffix = Path(name).suffix.lower()
                mime = {'.webp':'image/webp','.png':'image/png','.ogg':'audio/ogg','.wav':'audio/wav',
                        '.atlas':'text/plain','.skel':'application/octet-stream'}.get(suffix)
                if not mime: return self.send_error(404)
                return self.send_bytes(body, mime)
            except (KeyError, OSError): return self.send_error(404)
        if path == '/synthetic/image.png':
            return self.send_bytes(PNG, 'image/png')
        if path == '/synthetic/audio.wav':
            return self.send_bytes(WAV, 'audio/wav')
        if path == '/favicon.ico':
            self.send_response(204)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        super().do_GET()

    def do_POST(self):
        size = min(int(self.headers.get('Content-Length', '0')), 20000)
        self.rfile.read(size)
        if urlsplit(self.path).path == '/__fixture_stop':
            self.send_bytes(b'{"stopped":true}', 'application/json')
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if urlsplit(self.path).path == '/synthetic/image-result':
            return self.send_bytes(b'{"data":{"image_url":"/synthetic/image.png"}}', 'application/json')
        if urlsplit(self.path).path == '/synthetic/tts-result':
            return self.send_bytes(b'{"data":{"audio_url":"/synthetic/audio.wav"}}', 'application/json')
        self.send_error(404)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8789)
    parser.add_argument('--archive-pack', type=Path)
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.archive_pack = args.archive_pack
    server.serve_forever()
