"""Exact-boundary additive integration. Never replaces the provider checkout."""
import argparse
import ast
import difflib
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def transform_server(source):
    ast.parse(source)
    if "homer_archive_storage" in source:
        raise ValueError("Archive routes already present; review instead of stacking")
    anchor = "import json\n"
    if source.count(anchor) != 1:
        raise ValueError("JSON import boundary changed")
    source = source.replace(anchor, anchor + "from homer_archive_storage import read_games, write_game, ArchiveStorageError\n", 1)
    anchor = '''        if normalized in (
            "console/api/web/dialogue/runtime-state",'''
    if source.count(anchor) != 1:
        raise ValueError("Runtime route boundary changed")
    route = '''        if normalized == "console/api/web/archive/saves":
            token_user = self.authenticated_token_user()
            if not token_user:
                return error_response("unauthorized", 401)
            try:
                owner = str(token_user["id"])
                if self.command.upper() == "GET":
                    result = read_games(self.store, owner,
                                        parse_query_str(query, "game_id", ""),
                                        parse_query_int(query, "page", 1, 1, 1000))
                elif self.command.upper() == "POST" and isinstance(body, dict):
                    result = write_game(self.store, owner, body)
                else:
                    return error_response("method not allowed", 405)
                return ok_response(result)
            except ArchiveStorageError as exc:
                return error_response(str(exc), exc.status)

'''
    result = source.replace(anchor, route + anchor, 1)
    compile(result, "ai_fengyue_local_server.py", "exec")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    before = args.source.read_text(encoding="utf-8-sig")
    after = transform_server(before)
    args.destination.mkdir(parents=True, exist_ok=False)
    path = "tools/ai_fengyue_local_server.py"
    patch = "diff --git a/"+path+" b/"+path+"\n"+"".join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), fromfile="a/"+path, tofile="b/"+path))
    (args.destination / "backend.patch").write_bytes(patch.encode())
    module = (ROOT / "tools/server/homer_archive_storage.py").read_bytes()
    (args.destination / "homer_archive_storage.py").write_bytes(module)
    (args.destination / "manifest.json").write_text(json.dumps({"source_sha256_lf": hashlib.sha256(before.encode()).hexdigest(), "result_sha256_lf": hashlib.sha256(after.encode()).hexdigest(), "module_sha256": hashlib.sha256(module).hexdigest()}, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
