"""Build a hash-verified cumulative server candidate without editing a checkout.

R33's deployed-result source is verified first. Its original baseline is
reconstructed from the reviewed patch and checked against the original SHA.
The output remains a complete cumulative package, not a second overlay that a
maintainer could accidentally apply without the earlier community fixes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re

from export_r29_delivery import apply_unified, diff, text

ROOT = Path(__file__).resolve().parents[1]

OLD_RESOLVER = '''    def resolve_local_app_id(self, app_id: str) -> str:
        clean = unquote(str(app_id or "").strip())
        row = self.get_local_app(clean)
        return str(row["id"]) if row else clean
'''

NEW_RESOLVER = '''    def resolve_local_app_id(self, app_id: str) -> str:
        clean = unquote(str(app_id or "").strip())
        # Keep get_local_app's second normalization and exact-id precedence,
        # but resolve only the identifier, not megabytes of card extensions.
        # This is a fresh DB read, never a permission or cross-request cache.
        lookup_clean = unquote(str(clean or "").strip())
        if not lookup_clean:
            return clean
        with self.lock:
            row = self.conn.execute(
                "select id from local_apps where id=?", (lookup_clean,),
            ).fetchone()
            if row:
                return str(row["id"])
            lookup = lookup_clean[1:] if lookup_clean.startswith("#") else lookup_clean
            if lookup.lower().startswith("id:"):
                lookup = lookup[3:].strip()
            if not lookup:
                return clean
            row = self.conn.execute(
                "select id from local_apps where display_id=? and display_id<>''", (lookup,),
            ).fetchone()
            return str(row["id"]) if row else clean
'''

IMPORT_ANCHOR = 'from homer_images import route as image_route, ImageError\n'
SESSION_CONVERSION = '''            silly_card = silly_card_with_homer_cover(
                local_app_to_silly_card(app_data, card),
'''
MEMO_CONVERSION = '''            silly_card = silly_card_with_homer_cover(
                convert_session_card(local_app_to_silly_card, app_data, card,
                                     owner_id=user_id, conversation_id=conversation_id),
'''


def transform_server(source):
    """Exact reviewed boundaries only; fail closed on any upstream drift."""
    for old, new in [
        (IMPORT_ANCHOR, IMPORT_ANCHOR + 'from homer_session_cards import convert_session_card\n'),
        (OLD_RESOLVER, NEW_RESOLVER),
        (SESSION_CONVERSION, MEMO_CONVERSION),
    ]:
        if source.count(old) != 1:
            raise ValueError('Reviewed R41 server boundary changed')
        source = source.replace(old, new, 1)
    compile(source, 'ai_fengyue_local_server.py', 'exec')
    return source


def reverse_hunks(patch):
    output = []
    for line in patch.splitlines(keepends=True):
        match = re.match(r'@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@(.*)', line)
        if match:
            output.append('@@ -' + match[2] + ' +' + match[1] + ' @@' + match[3] + '\n')
        elif line.startswith('+++ '):
            output.append('--- ' + line[4:])
        elif line.startswith('--- '):
            output.append('+++ ' + line[4:])
        elif line.startswith('+'):
            output.append('-' + line[1:])
        elif line.startswith('-'):
            output.append('+' + line[1:])
        else:
            output.append(line)
    return ''.join(output)


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def export(source, destination):
    source, destination = source.resolve(), destination.resolve()
    if destination.exists():
        raise ValueError('Destination already exists; no existing file will be replaced')
    previous = ROOT / 'server-patches/cumulative-r33'
    records = json.loads(text(previous / 'manifest.json'))
    sections = re.split(r'(?=^diff --git )', text(previous / 'backend.patch'), flags=re.M)
    files, patches, manifest = {}, [], {}
    for name, record in records.items():
        if Path(name).name != name:
            raise ValueError('Only flat server modules are supported')
        current = text(source / name)
        if digest(current) != record['result_sha256_lf']:
            raise ValueError('R33 source hash mismatch: ' + name)
        original = None
        if record['baseline_sha256_lf']:
            matching = [section for section in sections
                        if section.startswith('diff --git a/tools/' + name + ' b/tools/' + name + '\n')]
            if len(matching) != 1:
                raise ValueError('R33 patch boundary missing or ambiguous: ' + name)
            original = apply_unified(current, reverse_hunks(matching[0]))
            if digest(original) != record['baseline_sha256_lf']:
                raise ValueError('Reconstructed original baseline mismatch: ' + name)
        result = transform_server(current) if name == 'ai_fengyue_local_server.py' else current
        files[name] = (original, result)
    files['homer_session_cards.py'] = (None, text(ROOT / 'tools/server/homer_session_cards.py'))
    for name, (original, result) in files.items():
        if name.endswith('.py'):
            compile(result, name, 'exec')
        patch = diff('tools/' + name, original, result)
        if original is not None and apply_unified(original, patch) != result:
            raise ValueError('Cumulative round-trip mismatch: ' + name)
        patches.append(patch)
        manifest[name] = {'baseline_sha256_lf': digest(original) if original is not None else None,
                          'result_sha256_lf': digest(result)}
    destination.mkdir(parents=True)
    # Generated delivery artifacts, after all validation. No live source,
    # running test server, database, account or repository state is changed.
    (destination / 'backend.patch').write_bytes(''.join(patches).encode('utf-8'))
    (destination / 'manifest.json').write_bytes((json.dumps(manifest, indent=2) + '\n').encode('utf-8'))
    for name, (original, result) in files.items():
        if original is None:
            (destination / name).write_bytes(result.encode('utf-8'))
    print('PASS: R41 complete server candidate exported; source hashes and round-trip verified.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True, help='Verified R33 result tools directory')
    parser.add_argument('--destination', type=Path, required=True, help='New generated package directory')
    args = parser.parse_args()
    export(args.source, args.destination)


if __name__ == '__main__':
    main()
