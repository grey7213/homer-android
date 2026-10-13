"""Reconstruct the full accepted patch chain without resetting the live index."""
import hashlib
import json
import subprocess
import argparse
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'.web-cache/tree'
DEST=ROOT/'output/preset-ball-r367/reconstructed-web-final'
def run(args,cwd=None,input=None):
    r=subprocess.run(args,cwd=cwd,input=input,capture_output=True)
    if r.returncode: raise RuntimeError(r.stderr.decode('utf-8',errors='replace')[-2200:])
    return r.stdout
def main():
    global DEST
    parser=argparse.ArgumentParser()
    parser.add_argument('--destination',type=Path,default=DEST)
    DEST=parser.parse_args().destination.resolve()
    if DEST.exists(): raise ValueError('Task verification destination already exists; not overwritten')
    pin=json.loads((ROOT/'web-base.json').read_text())['commit']
    run(['git','clone','--shared','--no-checkout',str(SOURCE),str(DEST)])
    run(['git','config','core.autocrlf','false'],DEST)
    run(['git','fetch','--depth=1',str(SOURCE),pin],DEST)
    run(['git','checkout','--detach',pin],DEST)
    patches=sorted((ROOT/'web-patches').glob('*.patch'))
    for patch in patches: run(['git','apply','-3','--index',str(patch)],DEST)
    records=[]
    entries=run(['git','ls-files','-s','-z'],DEST).split(b'\0')
    paths=[entry.split(b'\t',1)[1] for entry in entries if entry]
    attributes=run(['git','check-attr','-z','text','--stdin'],DEST,input=b'\0'.join(paths)+b'\0').split(b'\0')
    binary={attributes[i].decode('utf-8') for i in range(0,len(attributes)-2,3) if attributes[i+2]==b'unset'}
    mismatches=[]
    for entry in entries:
        if not entry: continue
        meta,rawpath=entry.split(b'\t',1); _,blob,stage=meta.split(); assert stage==b'0'
        name=rawpath.decode('utf-8'); file=SOURCE/name
        if not file.is_file(): mismatches.append(name+':missing');continue
        data=file.read_bytes()
        if b'\0' not in data[:8000] and name not in binary: data=data.replace(b'\r\n',b'\n')
        calculated=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
        if calculated!=blob.decode(): mismatches.append(name)
        records.append(name)
    report={'pin':pin,'patches':[p.name for p in patches],'files_compared':len(records),'mismatches':mismatches,
      'reconstructed':str(DEST),'production_changed':False}
    (DEST.parent/'patch-chain-report.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    assert not mismatches,mismatches
    print(json.dumps(report))
if __name__=='__main__':main()
