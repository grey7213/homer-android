"""Generate reviewable host changes against the maintainer's actual source.

Only writes the requested staging directory and patch; never modifies the host.
"""
from pathlib import Path
import argparse
import difflib


def transform_model_catalog(source):
    start = source.index('    def public_model_presets(self) -> dict:')
    end = source.index('\n    def ', start + 5)
    original = source[start:end]
    updated = original.replace('seen_models: set[str] = set()', 'seen_models: set[tuple[str, str]] = set()')
    updated = updated.replace('if not model or model in seen_models:', 'if not model or (p["id"], model) in seen_models:')
    updated = updated.replace('seen_models.add(model)', 'seen_models.add((p["id"], model))')
    updated = updated.replace('"preset_id": p["id"],', '"preset_id": p["id"], "group_id": p["id"], "group_name": str(p.get("name") or "站点模型"), "preset_name": str(p.get("name") or "站点模型"),')
    if updated == original or '"group_name"' not in updated: raise ValueError('Unrecognized model catalog baseline')
    return source[:start] + updated + source[end:]


def transform_workshop(source):
    source = source.replace('MAX_ENTRY_JSON_BYTES = 32 * 1024', 'MAX_ENTRY_JSON_BYTES = 8 * 1024 * 1024')
    source = source.replace('MAX_CONTENT_JSON_BYTES = 512 * 1024', 'MAX_CONTENT_JSON_BYTES = 8 * 1024 * 1024')
    source = source.replace('WORK_TYPES = {"mod", "ui_template", "preset"}', 'WORK_TYPES = {"mod", "ui_template", "preset", "regex"}')
    source = source.replace('content.get("entries") or content.get("prompts") or content.get("blocks") or []', 'content.get("entries") or content.get("prompts") or content.get("blocks") or content.get("regex_scripts") or []')
    source = source.replace('item.get("name") or item.get("title")', 'item.get("scriptName") or item.get("name") or item.get("title")')
    source = source.replace('for key in ("entries", "prompts", "blocks"):', 'for key in ("entries", "prompts", "blocks", "regex_scripts"):')
    source = source.replace('in {"mod", "preset"}', 'in {"mod", "preset", "regex"}')
    needle = '        for entry in entries:\n            if not isinstance(entry, dict):\n                raise ValueError("content entries must be objects")'
    replacement = needle + '\n            if work_type == "regex" and not isinstance(entry.get("findRegex", entry.get("find")), str):\n                raise ValueError("regex pattern is required")'
    if needle not in source: raise ValueError('Unrecognized workshop validation baseline')
    return source.replace(needle, replacement)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', type=Path, required=True)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--patch', type=Path, required=True)
    args = parser.parse_args()
    patches = []
    for name, transform in [('ai_fengyue_local_server.py', transform_model_catalog), ('community_workshop.py', transform_workshop)]:
        source = (args.host / 'tools' / name).read_text(encoding='utf-8-sig')
        target = transform(source)
        destination = args.stage / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(target, encoding='utf-8', newline='\n')
        patches.append(''.join(difflib.unified_diff(source.splitlines(True), target.splitlines(True), fromfile='a/tools/' + name, tofile='b/tools/' + name)))
    args.patch.parent.mkdir(parents=True, exist_ok=True)
    args.patch.write_text(''.join(patches), encoding='utf-8', newline='\n')
    print('Generated model grouping and regex resource host patch.')


if __name__ == '__main__': main()
