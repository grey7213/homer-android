"""Verify one cumulative patch on a fresh, pinned validation clone.

Never resets the active workspace. Keeps the validation directory for inspection.
"""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(args, cwd=None):
    p = subprocess.run(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode:
        raise RuntimeError(p.stderr.decode('utf-8', errors='replace')[-3000:])
    return p.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--patch', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    a = parser.parse_args()
    dest = a.destination.resolve()
    if dest.exists():
        raise SystemExit('Destination must not exist; existing data is never overwritten.')
    source = ROOT / '.web-cache/tree'
    pin = json.loads((ROOT / 'web-base.json').read_text())['commit']
    run(['git', 'clone', '--shared', '--no-checkout', str(source), str(dest)])
    run(['git', 'config', 'core.autocrlf', 'false'], dest)
    # A shallow source may keep pin only in FETCH_HEAD. Local clone does not
    # necessarily share alternates in that case, so explicitly fetch the pin.
    run(['git', 'fetch', '--depth=1', str(source), pin], dest)
    run(['git', 'checkout', '--detach', pin], dest)
    run(['git', 'apply', '-3', '--index', str(a.patch.resolve())], dest)
    entries = run(['git', 'ls-files', '-s', '-z'], dest).split(b'\0')
    mismatch = []
    count = 0
    for entry in entries:
        if not entry:
            continue
        metadata, raw_path = entry.split(b'\t', 1)
        path = raw_path.decode('utf-8')
        _, blob, stage = metadata.split()
        assert stage == b'0', path
        actual = source / path
        if not actual.is_file():
            mismatch.append(path + ': missing from active source')
            continue
        data = actual.read_bytes()
        if b'\0' not in data[:8000]:
            data = data.replace(b'\r\n', b'\n')
        calculated = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        if calculated != blob.decode():
            mismatch.append(path)
        count += 1
    assert not mismatch, mismatch
    report = {'pin': pin, 'patch': a.patch.name, 'files_compared': count, 'mismatches': mismatch}
    (dest.parent / 'web-verification.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
