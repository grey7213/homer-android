"""Apply a cumulative server patch to a disposable copy and verify every hash."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def digest(path):
    return hashlib.sha256(path.read_text(encoding='utf-8-sig').replace('\r\n', '\n').encode()).hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--baseline', type=Path, required=True)
    p.add_argument('--package', type=Path, required=True)
    p.add_argument('--destination', type=Path, required=True)
    a = p.parse_args()
    dest = a.destination.resolve()
    if dest.exists():
        raise SystemExit('Destination already exists; no existing files will be replaced.')
    manifest = json.loads((a.package / 'manifest.json').read_text())
    for name, record in manifest.items():
        assert Path(name).name == name, 'Manifest must name flat modules only'
        if record['baseline_sha256_lf']:
            assert digest(a.baseline / name) == record['baseline_sha256_lf'], name
    (dest / 'tools').mkdir(parents=True)
    for name, record in manifest.items():
        if record['baseline_sha256_lf']:
            (dest / 'tools' / name).write_text((a.baseline / name).read_text(encoding='utf-8-sig'), encoding='utf-8', newline='\n')
    subprocess.run(['git', 'init', '--quiet', str(dest)], check=True)
    patch = str((a.package / 'backend.patch').resolve())
    subprocess.run(['git', '-C', str(dest), 'apply', '--check', patch], check=True)
    subprocess.run(['git', '-C', str(dest), 'apply', patch], check=True)
    for name, record in manifest.items():
        assert digest(dest / 'tools' / name) == record['result_sha256_lf'], name
    print(f'PASS: git apply on verified baseline; all {len(manifest)} result hashes match.')


if __name__ == '__main__':
    main()
