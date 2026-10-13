"""Incremental R368 delta against verified reconstructed R367; preserve live index."""
import json
import subprocess
import tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'.web-cache/tree'
BASE=ROOT/'output/preset-ball-r367/reconstructed-web-delivery'
PATHS=['sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js',
       'sillytavern-runtime/public/scripts/extensions/homer-preset-ball/manifest.json',
       'sillytavern-runtime/public/scripts/homer-message-frames.mjs',
       'sillytavern-runtime/public/scripts/homer-async-fonts.mjs',
       'sillytavern-runtime/public/scripts/extensions/third-party/js-slash-runner/dist/index.js']
def main():
    if not BASE.is_dir():raise ValueError('Verified R367 baseline required')
    captured=ROOT/'output/mod-return-r368/baseline'/PATHS[0]
    if captured.read_bytes().replace(b'\r\n',b'\n')!=(BASE/PATHS[0]).read_bytes().replace(b'\r\n',b'\n'):
        raise ValueError('Captured initial source is not exact R367 baseline')
    binary=set()
    for path in PATHS:
        attr=subprocess.run(['git','check-attr','text','--',path],cwd=SOURCE,check=True,capture_output=True,text=True).stdout
        if attr.strip().endswith(': unset'):binary.add(path)
    def content(file,path):
        raw=file.read_bytes()
        return raw if path in binary else raw.replace(b'\r\n',b'\n')
    with tempfile.TemporaryDirectory(prefix='homer-r368-diff-') as tmp:
        directory=Path(tmp)
        subprocess.run(['git','init','-q'],cwd=directory,check=True)
        subprocess.run(['git','config','core.autocrlf','false'],cwd=directory,check=True)
        for path in PATHS:
            if (BASE/path).is_file():
                target=directory/path;target.parent.mkdir(parents=True,exist_ok=True)
                target.write_bytes(content(BASE/path,path))
        subprocess.run(['git','add','.'],cwd=directory,check=True)
        for path in PATHS:
            target=directory/path;target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(content(SOURCE/path,path))
        subprocess.run(['git','add','-N','--',*PATHS],cwd=directory,check=True)
        data=subprocess.run(['git','diff','--binary','--full-index','--',*PATHS],cwd=directory,check=True,capture_output=True).stdout
        if not data:raise ValueError('No task delta')
        out=ROOT/'web-patches/20261012-return-rich-messages-r368.patch'
        out.write_bytes(b'# R368 Android Mod-return and rich-message interaction repair\n# Incremental after 20261012-preset-ball-r367.patch; no Wind/ChatArchive source transplant.\n\n'+data)
        print(json.dumps({'patch':str(out),'bytes':out.stat().st_size}))
if __name__=='__main__':main()
