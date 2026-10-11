"""Exact legacy provider methods and authenticated route excerpt for isolated
SQLite contract tests. Not a deployable provider or production service.
No credentials, database rows, sessions or other provider functions.
"""
import json

class Provider:
    @staticmethod
    def _runtime_json(field: str, value: object) -> tuple[object, str]:
        if field == "script_trees":
            normalized = value if isinstance(value, (dict, list)) else {}
        else:
            normalized = value if isinstance(value, dict) else {}
        blob = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))
        limit = ST_RUNTIME_JSON_LIMITS[field]
        if len(blob.encode("utf-8")) > limit:
            raise ValueError(f"{field} 过大，最大 {limit} bytes")
        return normalized, blob

    def get_sillytavern_runtime_state(
        self,
        user_id: str,
        app_id: str = "",
        conversation_id: str = "",
    ) -> dict:
        clean_user = str(user_id or "").strip()
        clean_app = str(app_id or "").strip()
        clean_conv = str(conversation_id or "").strip()
        scopes = [("", "")]
        if clean_app:
            scopes.append((clean_app, ""))
        if clean_app and clean_conv:
            scopes.append((clean_app, clean_conv))
        fields = {
            "extension_settings": "extension_settings_json",
            "worldbook_overrides": "worldbook_overrides_json",
            "regex_overrides": "regex_overrides_json",
            "script_trees": "script_trees_json",
            "mvu_state": "mvu_state_json",
            "variables": "variables_json",
        }
        merged: dict[str, object] = {
            "extension_settings": {},
            "worldbook_overrides": {},
            "regex_overrides": {},
            "script_trees": {},
            "mvu_state": {},
            "variables": {},
        }
        updated_at = 0
        with self.lock:
            for scope_app, scope_conv in scopes:
                row = self.conn.execute(
                    "select * from sillytavern_runtime_states "
                    "where user_id=? and app_id=? and conversation_id=?",
                    (clean_user, scope_app, scope_conv),
                ).fetchone()
                if not row:
                    continue
                updated_at = max(updated_at, int(row["updated_at"] or 0))
                for field, column in fields.items():
                    try:
                        value = json.loads(row[column] or "{}")
                    except Exception:
                        value = {}
                    if isinstance(merged[field], dict) and isinstance(value, dict):
                        merged[field] = {**merged[field], **value}
                    elif value:
                        merged[field] = value
        return {
            **merged,
            "app_id": clean_app,
            "conversation_id": clean_conv,
            "updated_at": updated_at,
            "version": 1,
        }

    def save_sillytavern_runtime_state(
        self,
        user_id: str,
        app_id: str,
        conversation_id: str,
        data: dict,
    ) -> dict:
        clean_user = str(user_id or "").strip()
        clean_app = str(app_id or "").strip()
        clean_conv = str(conversation_id or "").strip()
        if not clean_user:
            raise ValueError("user_id is required")
        if not isinstance(data, dict):
            raise ValueError("invalid runtime state")
        field_columns = {
            "extension_settings": "extension_settings_json",
            "worldbook_overrides": "worldbook_overrides_json",
            "regex_overrides": "regex_overrides_json",
            "script_trees": "script_trees_json",
            "mvu_state": "mvu_state_json",
            "variables": "variables_json",
        }
        with self.lock:
            existing = self.conn.execute(
                "select * from sillytavern_runtime_states "
                "where user_id=? and app_id=? and conversation_id=?",
                (clean_user, clean_app, clean_conv),
            ).fetchone()
            values: dict[str, str] = {}
            for field, column in field_columns.items():
                if field in data:
                    _normalized, blob = self._runtime_json(field, data.get(field))
                    values[column] = blob
                else:
                    values[column] = str(existing[column] or "{}") if existing else "{}"
            ts = now_ms()
            self.conn.execute(
                """
                insert into sillytavern_runtime_states(
                    user_id,app_id,conversation_id,extension_settings_json,
                    worldbook_overrides_json,regex_overrides_json,script_trees_json,
                    mvu_state_json,variables_json,updated_at
                ) values(?,?,?,?,?,?,?,?,?,?)
                on conflict(user_id,app_id,conversation_id) do update set
                    extension_settings_json=excluded.extension_settings_json,
                    worldbook_overrides_json=excluded.worldbook_overrides_json,
                    regex_overrides_json=excluded.regex_overrides_json,
                    script_trees_json=excluded.script_trees_json,
                    mvu_state_json=excluded.mvu_state_json,
                    variables_json=excluded.variables_json,
                    updated_at=excluded.updated_at
                """,
                (
                    clean_user,
                    clean_app,
                    clean_conv,
                    values["extension_settings_json"],
                    values["worldbook_overrides_json"],
                    values["regex_overrides_json"],
                    values["script_trees_json"],
                    values["mvu_state_json"],
                    values["variables_json"],
                    ts,
                ),
            )
            self.conn.commit()
        return self.get_sillytavern_runtime_state(clean_user, clean_app, clean_conv)

class ReviewedRoute:
    def handle(self, normalized, query, body):
        if normalized in (
            "console/api/web/dialogue/runtime-state",
            "console/api/web/sillytavern/runtime-state",
        ):
            token_user = self.authenticated_token_user()
            if not token_user:
                return error_response("unauthorized", 401)
            if self.command.upper() == "GET":
                app_id = self.store.resolve_local_app_id(parse_query_str(query, "app_id", ""))
                conv_id = parse_query_str(query, "conversation_id", "")
            elif self.command.upper() == "POST" and isinstance(body, dict):
                app_id = self.store.resolve_local_app_id(str(body.get("app_id") or ""))
                conv_id = str(body.get("conversation_id") or "").strip()
            else:
                return error_response("method not allowed", 405)
            token_user_id = str(token_user["id"])
            if app_id:
                app_row = self.store.get_local_app(app_id)
                if not user_can_play_app(app_row, token_user_id):
                    return error_response("role not found", 404)
            if conv_id:
                conversation = self.store.get_conversation(conv_id, token_user_id)
                if not conversation:
                    return error_response("conversation not found", 404)
                conversation_app = self.store.resolve_local_app_id(str(conversation.get("app_id") or ""))
                if app_id and conversation_app != app_id:
                    return error_response("conversation role mismatch", 409)
                app_id = app_id or conversation_app
            if self.command.upper() == "GET":
                return ok_response(self.store.get_sillytavern_runtime_state(token_user_id, app_id, conv_id))
            try:
                state = self.store.save_sillytavern_runtime_state(token_user_id, app_id, conv_id, body)
            except ValueError as exc:
                return error_response(str(exc), 400)
            return ok_response(state)
