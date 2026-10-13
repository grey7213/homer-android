"""Exact-boundary incremental provider handoff; never edits the input checkout."""
from pathlib import Path
import ast
import argparse
import hashlib
import json
import difflib

ROOT = Path(__file__).resolve().parents[1]


def transform_server(source):
    tree = ast.parse(source)
    fn = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == 'sync_sillytavern_chat']
    if len(fn) != 1:
        raise ValueError('Expected one reviewed chat storage method')
    fn = fn[0]
    old = '\n'.join(source.splitlines()[fn.lineno-1:fn.end_lineno])
    if 'delete from messages where conversation_id=? and user_id=?' not in old:
        raise ValueError('Legacy replace boundary changed; review before export')
    new = '''    def sync_sillytavern_chat(self, conv_id, user_id, app_id, messages, *, title="",
                            storage_version="", storage_commit_id="", storage_fork=False):
        return write_chat(self, str(user_id), self.resolve_local_app_id(str(app_id)),
                          str(conv_id), messages, title=title, version=storage_version,
                          commit_id=storage_commit_id, fork=storage_fork)
'''.rstrip()
    source = source.replace(old,new,1)
    # Place import beside stdlib import, independent of unrelated R41 integration.
    anchor='import json\n'
    if source.count(anchor) != 1: raise ValueError('JSON import boundary changed')
    source=source.replace(anchor,anchor+'from homer_chat_storage import read_chat, write_chat, ChatStorageError\n',1)
    old='            messages = self.store.list_messages(conversation_id, user_id, limit=500)\n'
    new='''            stored_chat = read_chat(self.store, user_id, app_id, conversation_id,
                                    parse_query_str(query, "chat_version", ""))
            messages = stored_chat["messages"]
'''
    if source.count(old)!=1: raise ValueError('Session message boundary changed')
    source=source.replace(old,new,1)
    anchor='''                "messages": messages,
                "runtime_config": runtime_config,'''
    if source.count(anchor)!=1: raise ValueError('Session metadata boundary changed')
    source=source.replace(anchor,'''                "messages": messages,
                "storage": stored_chat["storage"],
                "runtime_config": runtime_config,''',1)
    anchor='''                    title=str(body.get("title") or ""),
                )
            except ValueError as exc:
                return error_response(str(exc), 400)
            self.store.log_event('''
    if source.count(anchor)!=1: raise ValueError('Storage route boundary changed')
    source=source.replace(anchor,'''                    title=str(body.get("title") or ""),
                    storage_version=body.get("storage_version") or "",
                    storage_commit_id=body.get("storage_commit_id") or "",
                    storage_fork=body.get("storage_fork") is True,
                )
            except ChatStorageError as exc:
                return error_response(str(exc), exc.status)
            except ValueError as exc:
                return error_response(str(exc), 400)
            self.store.log_event(''',1)
    compile(source,'ai_fengyue_local_server.py','exec')
    return source


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--destination',type=Path,required=True)
    args=parser.parse_args()
    before=args.source.read_text(encoding='utf-8-sig')
    after=transform_server(before)
    args.destination.mkdir(parents=True,exist_ok=False)
    name='tools/ai_fengyue_local_server.py'
    patch='diff --git a/'+name+' b/'+name+'\n'+''.join(difflib.unified_diff(before.splitlines(True),after.splitlines(True),fromfile='a/'+name,tofile='b/'+name))
    (args.destination/'backend.patch').write_bytes(patch.encode('utf-8'))
    module=(ROOT/'tools/server/homer_chat_storage.py').read_bytes()
    (args.destination/'homer_chat_storage.py').write_bytes(module)
    (args.destination/'manifest.json').write_text(json.dumps({'source_sha256_lf':hashlib.sha256(before.encode()).hexdigest(),'result_sha256_lf':hashlib.sha256(after.encode()).hexdigest(),'module_sha256':hashlib.sha256(module).hexdigest()},indent=2)+'\n',encoding='utf-8')


if __name__=='__main__': main()
