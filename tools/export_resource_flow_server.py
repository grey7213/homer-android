"""Reviewed, exact-boundary workshop soft-deletion handoff. Never deploys or
edits the source tree; export a patch for the provider owner to apply."""
import argparse
import ast
import difflib
import hashlib
import json
from pathlib import Path


def transform_workshop(source):
    replacements = [
        ('        where, args = [], []\n', '        where, args = ["status!=\'deleted\'"], []\n'),
        ('        if not row:\n            return False\n        return bool(\n', '        if not row or row.get("status") == "deleted":\n            return False\n        return bool(\n'),
        ('                locked = dict(locked_row)\n                merged = dict(locked)\n', '                locked = dict(locked_row)\n                if locked.get("status") == "deleted":\n                    raise ValueError("work not available")\n                merged = dict(locked)\n'),
        ('                if not value or (value.get("owner_user_id") != user_id', '                if not value or value.get("status") == "deleted" or (value.get("owner_user_id") != user_id'),
    ]
    ast.parse(source)
    for old, new in replacements:
        if source.count(old) != 1:
            raise ValueError('Workshop deletion boundary changed; review before export')
        source = source.replace(old, new, 1)
    compile(source, 'community_workshop.py', 'exec')
    return source


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    before = args.source.read_text(encoding='utf-8-sig')
    after = transform_workshop(before)
    args.destination.mkdir(parents=True, exist_ok=True)
    patch = ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile='a/tools/community_workshop.py', tofile='b/tools/community_workshop.py'))
    (args.destination / 'backend.patch').write_text(patch, encoding='utf-8', newline='\n')
    (args.destination / 'manifest.json').write_text(json.dumps({
        'scope': 'workshop soft-deletion visibility and write guards',
        'source_lf_sha256': hashlib.sha256(before.encode('utf-8')).hexdigest(),
        'result_lf_sha256': hashlib.sha256(after.encode('utf-8')).hexdigest(),
        'deployed': False,
    }, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
