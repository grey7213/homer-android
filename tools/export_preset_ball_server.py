"""Export a pinned, incremental metadata patch; never deploy or overwrite input."""
import argparse
import ast
import difflib
import hashlib
import json
from pathlib import Path

def adapt(source):
    old = 'entries = _prompt_preset_public_entries(preset, override_map, source="card_prompt")'
    new = 'entries = _prompt_preset_public_entries(preset, override_map, require_user_toggleable=True, source="card_prompt")'
    if source.count(old) != 1:
        raise ValueError('Card preset disclosure contract changed; inspect before applying')
    source = source.replace(old, new, 1)
    old = 'current_prompt_config = global_prompt_config if global_prompt_config.get("preset_id") else card_prompt_config'
    new = 'current_prompt_config = card_prompt_config if card_prompt_config.get("preset_id") and card_prompt_config.get("enabled") else global_prompt_config'
    if source.count(old) != 1:
        raise ValueError('Bound preset contract changed; inspect before applying')
    source = source.replace(old, new, 1)
    old = '''            "current_prompt": current_prompt_config,
            "prompt": current_prompt_config,'''
    new = '''            "current_prompt": current_prompt_config,
            "prompt": current_prompt_config,
            "card_prompt": card_prompt_config,
            "global_prompt": global_prompt_config,'''
    if source.count(old) != 1:
        raise ValueError('Runtime metadata contract changed; inspect before applying')
    source = source.replace(old, new, 1)
    ast.parse(source)
    return source

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--source', required=True)
    p.add_argument('--destination', required=True)
    args = p.parse_args()
    original = Path(args.source).read_text(encoding='utf-8')
    changed = adapt(original)
    destination = Path(args.destination)
    destination.mkdir(parents=True, exist_ok=True)
    patch = ''.join(difflib.unified_diff(original.splitlines(True), changed.splitlines(True),
        fromfile='a/tools/ai_fengyue_local_server.py', tofile='b/tools/ai_fengyue_local_server.py'))
    (destination / 'backend.patch').write_text(patch, encoding='utf-8', newline='\n')
    (destination / 'manifest.json').write_text(json.dumps({
        'source': 'tools/ai_fengyue_local_server.py',
        'source_sha256_lf': hashlib.sha256(original.encode()).hexdigest(),
        'adapted_sha256_lf': hashlib.sha256(changed.encode()).hexdigest(),
        'deployed': False,
        'behavior': 'Expose authorized card/global metadata, prefer explicitly enabled bound card; no provider/account/storage replacement',
    }, indent=2) + '\n', encoding='utf-8')
    print('Exported metadata-only backend patch; not deployed')

if __name__ == '__main__':
    main()
