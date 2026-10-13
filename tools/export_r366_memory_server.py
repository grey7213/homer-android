"""Export an exact-boundary, additive memory provider patch; never edit source."""
from pathlib import Path
import argparse
import ast
import difflib
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]


def transform_server(source):
    tree = ast.parse(source)
    for name, helper, arguments in [
        ('get_sillytavern_runtime_state', 'read_runtime_state', 'self, user_id, app_id, conversation_id'),
        ('save_sillytavern_runtime_state', 'write_runtime_state', 'self, user_id, app_id, conversation_id, data'),
    ]:
        functions = [node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == name]
        if len(functions) != 1:
            raise ValueError('Expected one unpatched runtime-state method: ' + name)
        node = functions[0]
        old = '\n'.join(source.splitlines()[node.lineno - 1:node.end_lineno])
        if 'sillytavern_runtime_states' not in old:
            raise ValueError('Runtime storage boundary changed')
        private = old.replace('def ' + name + '(', 'def _' + name + '_legacy(', 1)
        signature = ('user_id, app_id="", conversation_id=""' if name.startswith('get_')
                     else 'user_id, app_id, conversation_id, data')
        new = private + f'\n\n    def {name}(self, {signature}):\n        return {helper}({arguments})'
        source = source.replace(old, new, 1)
        tree = ast.parse(source)
    anchor = 'import json\n'
    if source.count(anchor) != 1:
        raise ValueError('Import boundary changed')
    source = source.replace(anchor, anchor + 'from homer_memory_storage import read_runtime_state, write_runtime_state, MemoryStorageError\n', 1)
    anchor = '''                state = self.store.save_sillytavern_runtime_state(token_user_id, app_id, conv_id, body)
            except ValueError as exc:
                return error_response(str(exc), 400)'''
    if source.count(anchor) != 1:
        raise ValueError('Authenticated runtime-state route boundary changed')
    source = source.replace(anchor, anchor.replace('return error_response(str(exc), 400)',
        'return error_response(str(exc), exc.status if isinstance(exc, MemoryStorageError) else 400)'), 1)
    ast.parse(source)
    return source


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--destination', required=True)
    args = parser.parse_args()
    path, destination = Path(args.source), Path(args.destination)
    # Keep CRLF in the input manifest, normalize only the reviewed patch text.
    raw = path.read_bytes()
    source = raw.decode('utf-8').replace('\r\n', '\n')
    changed = transform_server(source)
    destination.mkdir(parents=True, exist_ok=True)
    patch = ''.join(difflib.unified_diff(source.splitlines(True), changed.splitlines(True),
        fromfile='a/tools/ai_fengyue_local_server.py', tofile='b/tools/ai_fengyue_local_server.py'))
    (destination / 'backend.patch').write_text(patch, encoding='utf-8', newline='\n')
    helper = (ROOT / 'server-patches/memory-cloud-r366/homer_memory_storage.py').read_bytes()
    if destination.resolve() != (ROOT / 'server-patches/memory-cloud-r366').resolve():
        (destination / 'homer_memory_storage.py').write_bytes(helper)
    manifest = {'schema_version': 1, 'source_sha256': hashlib.sha256(raw).hexdigest(),
        'helper_sha256': hashlib.sha256(helper).hexdigest(), 'contract': 'runtime-state optional private memory v1',
        'deployed': False}
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'exported': True, 'deployed': False, 'source_sha256': manifest['source_sha256']}))


if __name__ == '__main__':
    main()
