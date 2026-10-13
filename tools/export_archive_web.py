"""Export only the additive accepted archive changes above the existing patch chain.

Generates a fresh private validation tree, never resets the developer checkout.
Exact-byte bulk copies are mechanical export inputs, not edits to user files.
Stopped feature trees, dependencies and account/media QA files are excluded.
"""
import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'.web-cache/tree'
EXCLUDED=('frontend/app/ai-story.html','frontend/app/assets/ai-story/','frontend/app/assets/js/ai-story-bootstrap.mjs')

def git(*args,cwd):
    result=subprocess.run(['git',*args],cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if result.returncode:raise RuntimeError(result.stderr.decode('utf-8',errors='replace')[-3000:])
    return result.stdout

def accepted(path):
    return path.startswith(('frontend/','sillytavern-runtime/')) and not any(path==p or path.startswith(p) for p in EXCLUDED)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--destination',type=Path,required=True);parser.add_argument('--patch',type=Path,required=True);args=parser.parse_args()
    dest=args.destination.resolve();patch=args.patch.resolve()
    if dest.exists() or patch.exists():raise ValueError('Use new export paths, never overwrite prior evidence')
    pin=json.loads((ROOT/'web-base.json').read_text(encoding='utf-8'))['commit']
    git('clone','--shared','--no-checkout',str(SOURCE),str(dest),cwd=ROOT)
    git('config','core.autocrlf','false',cwd=dest);git('fetch','--depth=1',str(SOURCE),pin,cwd=dest);git('checkout','--detach',pin,cwd=dest)
    preceding=sorted((ROOT/'web-patches').glob('*.patch'))
    for existing in preceding:git('apply','-3','--index',str(existing),cwd=dest)
    baseline=git('write-tree',cwd=dest).decode().strip()
    paths=set(git('ls-files','-z','--','frontend','sillytavern-runtime',cwd=SOURCE).decode().split('\0'))
    paths.update(git('ls-files','--others','--exclude-standard','-z','--','frontend','sillytavern-runtime',cwd=SOURCE).decode().split('\0'))
    paths={p for p in paths if accepted(p)}
    old=git('ls-files','-z',cwd=dest).decode().split('\0')
    for path in old:
        if accepted(path) and not (SOURCE/path).is_file():
            target=(dest/path).resolve()
            if dest not in target.parents:raise ValueError('Unsafe export removal')
            target.unlink(missing_ok=True)
    raw_text=set()
    for offset in range(0,len(paths),35):
        attributes=git('check-attr','-z','text','--',*sorted(paths)[offset:offset+35],cwd=dest).decode().split('\0')
        raw_text.update(attributes[i] for i in range(0,len(attributes)-2,3) if attributes[i+2]=='unset')
    for path in paths:
        source=SOURCE/path
        if not source.is_file():continue
        target=dest/path;target.parent.mkdir(parents=True,exist_ok=True)
        data=source.read_bytes()
        # Match the repository's canonical text comparison. Never normalize
        # binary files or authored -text maps/bundles. Do not touch source files.
        if path not in raw_text and b'\0' not in data[:8000]:data=data.replace(b'\r\n',b'\n')
        target.write_bytes(data)
    to_stage=sorted(paths|{p for p in old if accepted(p)})
    for offset in range(0,len(to_stage),35):
        git('add','-A','--',*to_stage[offset:offset+35],cwd=dest)
    data=git('diff','--cached','--binary','--full-index',baseline,cwd=dest)
    if not data:raise ValueError('No additive web changes')
    if any(p.encode() in data for p in EXCLUDED):raise ValueError('Stopped feature found in exported diff')
    patch.parent.mkdir(parents=True,exist_ok=True)
    header=f'# Archive additive web patch; apply after the existing ordered chain.\n# pinned-base: {pin}\n# prior-tree: {baseline}\n\n'.encode()
    patch.write_bytes(header+data)
    report={'pin':pin,'prior_tree':baseline,'preceding_patches':[p.name for p in preceding],
        'additive_patch':patch.name,'patch_sha256':hashlib.sha256(header+data).hexdigest(),'source_files':len(paths),'excluded':EXCLUDED}
    (dest.parent/'archive-export.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report))

if __name__=='__main__':main()
