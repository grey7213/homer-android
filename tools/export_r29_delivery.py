"""Export only R29 deltas using the R27 patch's exact result blobs + R28.1 patch.

Does not reset, stage, or change a checkout. Generated patches are round-trip checked.
"""
import difflib, hashlib, json, re, subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]; TREE=ROOT/'.web-cache/tree'
BACKEND=Path('D:/网站/功能/AIXingYue-main/tools')
PATHS=['frontend/admin.html','frontend/assets/js/admin-app.js','frontend/assets/js/admin-dialogue.js','frontend/assets/css/admin-dialogue.css',
       'sillytavern-runtime/src/endpoints/homer.js','sillytavern-runtime/public/scripts/openai.js',
       'sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js','sillytavern-runtime/public/scripts/extensions/homer-bridge/style.css',
       'sillytavern-runtime/public/scripts/extensions/regex/engine.js','sillytavern-runtime/public/scripts/homer-official-regex.mjs',
       'sillytavern-runtime/public/scripts/homer-generation-diagnostics.mjs',
       'sillytavern-runtime/src/endpoints/backends/chat-completions.js',
       'sillytavern-runtime/public/scripts/extensions/homer-bridge/admin-workspace.js',
       'sillytavern-runtime/public/scripts/extensions/homer-bridge/admin-workspace.css']
def git(*args):
    return subprocess.run(['git','-C',str(TREE),*args],capture_output=True,check=True).stdout.decode('utf-8').replace('\r\n','\n')
def text(path): return path.read_text(encoding='utf-8-sig').replace('\r\n','\n')
def apply_unified(original, patch):
    old=original.splitlines(keepends=True); out=[]; pos=0; lines=patch.splitlines(keepends=True); i=0
    while i<len(lines):
        m=re.match(r'@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@',lines[i])
        if not m: i+=1;continue
        i+=1;hunk=[]
        while i<len(lines) and lines[i][:1] in (' ','+','-') and not lines[i].startswith(('---','+++')):
            hunk.append(lines[i]);i+=1
        before=[line[1:] for line in hunk if line[0] in (' ','-')]
        candidates=[j for j in range(pos,len(old)-len(before)+1) if old[j:j+len(before)]==before]
        assert len(candidates)==1, ('ambiguous baseline',m[1])
        start=candidates[0];out.extend(old[pos:start]);pos=start+len(before)
        out.extend(line[1:] for line in hunk if line[0] in (' ','+'))
    out.extend(old[pos:]);return ''.join(out)
def blob(s):
    b=s.encode('utf-8');return hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
def diff(path,old,new):
    if old==new:return ''
    meta=f'diff --git a/{path} b/{path}\n'
    if old is None:meta+='new file mode 100644\n'
    meta+=f'index {blob(old) if old is not None else "0"*40}..{blob(new)}'+(' 100644' if old is not None else '')+'\n'
    return meta+''.join(difflib.unified_diff((old or '').splitlines(keepends=True),new.splitlines(keepends=True),fromfile=f'a/{path}' if old is not None else '/dev/null',tofile=f'b/{path}'))
def main():
    r27=text(ROOT/'web-patches/20260925-2328-complete-web-mobile-r27.patch')
    blobs={m[1]:m[2] for m in re.finditer(r'diff --git a/(.*?) b/.*?\nindex [a-f0-9]+\.\.([a-f0-9]+)',r27)}
    fallback=text(ROOT/'web-patches/20260926-2359-runtime-session-fallback.patch')
    base_dir=ROOT/'output/mobile-r29/web-before';base_dir.mkdir(parents=True,exist_ok=True)
    patch=''
    for path in PATHS:
        try:old=git('cat-file','blob',blobs[path]) if path in blobs else git('show',f'HEAD:{path}')
        except subprocess.CalledProcessError:old=None
        if path.endswith('extensions/homer-bridge/index.js'):old=apply_unified(old,fallback)
        if old is not None:
            dest=base_dir/path;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(old,encoding='utf-8',newline='\n')
        patch+=diff(path,old,text(TREE/path))
    pin=json.loads(text(ROOT/'web-base.json'))['commit']
    out=ROOT/'web-patches/20260927-0001-regex-admin-preview-diagnostics-r29.patch'
    out.write_text(f'# 基线 commit: {pin}\n# 在 complete-web-mobile-r27 与 runtime-session-fallback 之后应用。\n\n'+patch,encoding='utf-8',newline='\n')
    # The reverse check proves every hunk describes the current tree, including additions.
    subprocess.run(['git','-C',str(TREE),'apply','--reverse','--check',str(out)],check=True)
    server=''
    for name in ['ai_fengyue_local_server.py','homer_generation.py','homer_regex.cjs']:
        previous=ROOT/'output/mobile-r29/baseline'/name
        server+=diff('tools/'+name,text(previous) if previous.exists() else None,text(BACKEND/name))
    server_dir=ROOT/'server-patches/r29';server_dir.mkdir(parents=True,exist_ok=True)
    (server_dir/'backend.patch').write_text(server,encoding='utf-8',newline='\n')
    # Standalone pure helpers are also included for portable unit tests/review.
    for name in ['homer_generation.py','homer_regex.cjs']:(server_dir/name).write_text(text(BACKEND/name),encoding='utf-8',newline='\n')
    subprocess.run(['git','-C',str(BACKEND.parent),'apply','--reverse','--check',str(server_dir/'backend.patch')],check=True)
    print(f'Exported {len(PATHS)}-file web delta and 3-file backend delta; both reverse checks passed.')
if __name__=='__main__':main()
