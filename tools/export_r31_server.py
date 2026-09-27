"""Combine independently verified R25-27 and R29 server changes, without touching a server.

Usage: python tools/export_r31_server.py --baseline DIR --current DIR
Baseline/current are tools directories. Output contains no DB, config or credentials.
"""
import argparse
import hashlib
import json
from pathlib import Path

from build_mobile_r26_server_patch import host, workshop, card_extra, locked_assets
from export_r29_delivery import apply_unified, diff, text

ROOT = Path(__file__).resolve().parents[1]


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--baseline', type=Path, required=True)
    p.add_argument('--current', type=Path, required=True)
    a = p.parse_args()
    target = ROOT / 'server-patches/cumulative-r31'
    stage = ROOT / 'output/mobile-r31-submission/server'
    target.mkdir(parents=True, exist_ok=True)
    stage.mkdir(parents=True, exist_ok=True)
    old_host = text(a.baseline / 'ai_fengyue_local_server.py')
    # Verify the current host really is the documented R29 delta on the original
    # baseline, not an arbitrary developer's entire server working directory.
    r29 = text(ROOT / 'server-patches/r29/backend.patch')
    host_delta = r29.split('diff --git a/tools/homer_generation.py')[0]
    assert apply_unified(old_host, host_delta) == text(a.current / 'ai_fengyue_local_server.py')
    records = {}
    patches = []
    modules = [('ai_fengyue_local_server.py', host), ('community_workshop.py', workshop),
               ('card_extra_workshop.py', card_extra), ('chat_mod_workshop.py', locked_assets),
               ('homer_generation.py', None), ('homer_regex.cjs', None)]
    for name, transform in modules:
        original = old_host if name == 'ai_fengyue_local_server.py' else (text(a.current / name) if transform else None)
        final = transform(text(a.current / name)) if transform else text(a.current / name)
        if name.endswith('.py'):
            compile(final, name, 'exec')
        patch = diff('tools/' + name, original, final)
        if original is not None:
            assert apply_unified(original, patch) == final
        patches.append(patch)
        (stage / name).write_text(final, encoding='utf-8', newline='\n')
        if not transform:
            (target / name).write_text(final, encoding='utf-8', newline='\n')
        records[name] = {
            'baseline_sha256_lf': hashlib.sha256(original.encode()).hexdigest() if original else None,
            'result_sha256_lf': hashlib.sha256(final.encode()).hexdigest(),
        }
    (target / 'backend.patch').write_text(''.join(patches), encoding='utf-8', newline='\n')
    (target / 'manifest.json').write_text(json.dumps(records, indent=2) + '\n', encoding='utf-8')
    print('PASS: six-file cumulative backend; exact R29 baseline verified; original files round-trip checked.')


if __name__ == '__main__':
    main()
