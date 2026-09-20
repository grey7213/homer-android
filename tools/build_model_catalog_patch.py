"""Generate a narrow backend patch; never change the server source or database."""
import argparse
import ast
import difflib
from pathlib import Path


def transform(source):
    tree = ast.parse(source)
    method = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == 'public_model_presets')
    lines = source.splitlines(keepends=True)
    old = ''.join(lines[method.lineno-1:method.end_lineno])
    new = old.replace('seen_models: set[str] = set()', 'seen_models: set[tuple[str, str]] = set()')
    new = new.replace('if not model or model in seen_models:', 'if not model or (p["id"], model) in seen_models:')
    new = new.replace('seen_models.add(model)', 'seen_models.add((p["id"], model))')
    new = new.replace('"preset_id": p["id"],\n', '"preset_id": p["id"],\n                    "group_id": p["id"],\n                    "group_name": str(p.get("name") or "模型分组"),\n')
    start = new.index('        if not visible and presets:')
    end = new.index('        return {"list": visible', start)
    new = new[:start] + '        default_id = next((p["id"] for p in visible if p.get("is_default")), visible[0]["id"] if visible else "")\n' + new[end:]
    assert new != old and 'group_name' in new and 'seen_models.add((p["id"], model))' in new
    result = ''.join(lines[:method.lineno-1]) + new + ''.join(lines[method.end_lineno:])
    ast.parse(result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    args = parser.parse_args()
    before = args.source.read_text(encoding='utf-8-sig')
    after = transform(before)
    target = Path(__file__).resolve().parents[1] / 'server-patches/model-catalog/integration.patch'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile='a/tools/ai_fengyue_local_server.py', tofile='b/tools/ai_fengyue_local_server.py')), encoding='utf-8')
    print('Generated only public_model_presets patch:', target)
