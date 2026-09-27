"""Generation diagnostics and regex execution. Never return provider secrets."""
import hashlib
import json
import os
from pathlib import Path
import subprocess


def preset_fingerprint(value):
    return hashlib.sha256(json.dumps(value or {}, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


def generation_error(status=502, reason="", request_id=""):
    # Only use locally classified reasons, never echo arbitrary provider bodies.
    code, message = {
        400: ("HM-G400", "请求参数无效，请调整后重试"),
        401: ("HM-G401", "登录或会话已过期，请重新进入会话"),
        402: ("HM-G402", "积分不足，请补充积分或选择消耗更低的模型"),
        403: ("HM-G403", "没有权限进行此操作"),
        404: ("HM-G404", "角色或会话已不可用，请重新选择"),
        409: ("HM-G409", "会话与角色不匹配，请重新进入会话"),
        429: ("HM-G429", "请求过于频繁，请稍后重试或更换模型"),
        503: ("HM-G503", "当前模型暂不可用，请更换模型后重试"),
        504: ("HM-G504", "当前模型响应超时，请更换模型后重试"),
    }.get(status, ("HM-G502", "当前模型生成失败，请更换模型后重试"))
    if reason == "empty":
        code, message = "HM-G204", "当前模型未返回有效内容，请更换模型后重试"
    elif reason == "regex":
        code, message = "HM-R422", "预设正则执行失败，请联系管理员检查规则"
    return {"error": {"code": code, "message": f"[{code}] {message}", "request_id": request_id}}


def execute_prompt_regex(messages, preset, *, user_name="用户", character_name="角色"):
    if not preset or not preset.get("enabled"):
        return messages
    worker = Path(__file__).with_name("homer_regex.cjs")
    # Separate, killable process: pathological admin regex must not hang server threads.
    payload = {"messages": messages, "scripts": preset.get("scripts") or [],
               "user": user_name, "char": character_name}
    try:
        result = subprocess.run([os.environ.get("HOMER_NODE_BINARY", "node"), "--max-old-space-size=96", str(worker)],
                                input=json.dumps(payload, ensure_ascii=False), text=True, encoding="utf-8",
                                capture_output=True, timeout=3, check=True,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        data = json.loads(result.stdout)
        if data.get("errors"):
            raise ValueError("official regex invalid")
        return data["messages"]
    except (OSError, subprocess.SubprocessError, ValueError, KeyError) as exc:
        raise RuntimeError("HM-R422") from exc


def display_regex(preset):
    """Only display transformations; private prompt-only rules stay on the server."""
    result = []
    if preset.get("enabled"):
        for raw in preset.get("scripts") or []:
            if raw.get("disabled") or (raw.get("promptOnly") and not raw.get("markdownOnly")):
                continue
            result.append({key: raw.get(key) for key in (
                "id", "scriptName", "findRegex", "replaceString", "trimStrings", "placement",
                "runOnEdit", "substituteRegex", "minDepth", "maxDepth", "order")})
            result[-1].update({"markdownOnly": True, "promptOnly": False, "disabled": False})
    return {"preset_id": preset.get("id") or "", "revision": preset_fingerprint(preset), "scripts": result}
