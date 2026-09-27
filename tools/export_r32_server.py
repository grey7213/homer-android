"""Export cumulative server source against the same verified pre-R25 baseline."""
import argparse
import hashlib
import json
from pathlib import Path
from export_r29_delivery import text, diff, apply_unified

ROOT=Path(__file__).resolve().parents[1]

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source',type=Path,required=True)
    p.add_argument('--baseline',type=Path,required=True)
    a=p.parse_args()
    previous=json.loads((ROOT/'server-patches/cumulative-r31/manifest.json').read_text())
    target=ROOT/'server-patches/cumulative-r32';target.mkdir(parents=True,exist_ok=True)
    records={};patches=[]
    for name, prior in previous.items():
        old=text(a.baseline/name) if prior['baseline_sha256_lf'] else None
        if old is not None: assert hashlib.sha256(old.encode()).hexdigest()==prior['baseline_sha256_lf'],name
        new=text(a.source/name)
        if name.endswith('.py'):compile(new,name,'exec')
        patch=diff('tools/'+name,old,new)
        if old is not None:assert apply_unified(old,patch)==new,name
        patches.append(patch)
        records[name]={'baseline_sha256_lf':prior['baseline_sha256_lf'],'result_sha256_lf':hashlib.sha256(new.encode()).hexdigest()}
        if old is None:(target/name).write_text(new,encoding='utf-8',newline='\n')
    (target/'backend.patch').write_text(''.join(patches),encoding='utf-8',newline='\n')
    (target/'manifest.json').write_text(json.dumps(records,indent=2)+'\n',encoding='utf-8')
    print('PASS: cumulative six-module backend exported; verified pre-R25 baseline and round-trip.')

if __name__=='__main__':main()
