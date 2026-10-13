"""Export task-owned unstaged delta after the already staged R366 patch chain."""
import hashlib
import json
import subprocess
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
TREE = ROOT / '.web-cache/tree'
paths = ['sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js',
         'sillytavern-runtime/public/scripts/openai.js',
         'sillytavern-runtime/public/scripts/extensions/homer-preset-ball']
def run(*args):
    return subprocess.run(['git', *args], cwd=TREE, check=True, capture_output=True).stdout
def main():
    # Only this task's previously absent module. Existing staged edits stay intact.
    run('add', '-N', '--', paths[2])
    run('add', '-N', '-f', '--', paths[2] + '/index.build.js.map')
    data = run('diff', '--binary', '--full-index', '--', *paths)
    if not data: raise ValueError('Empty transplant patch')
    out = ROOT / 'web-patches/20261012-preset-ball-r367.patch'
    header = b'# Homer authorized preset-ball source transplant\n# Apply after all existing patches through 20261011-integrated-r366.patch.\n# Incremental working-tree delta; not a cumulative replacement or production deployment.\n\n'
    out.write_bytes(header + data)
    print(json.dumps({'patch': str(out), 'bytes': out.stat().st_size, 'sha256': hashlib.sha256(out.read_bytes()).hexdigest()}))
if __name__ == '__main__': main()
