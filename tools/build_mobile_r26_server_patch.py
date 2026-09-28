"""R25 + unified UI-template/regex assets, without rewriting existing records."""
from pathlib import Path
import argparse
import difflib
from build_mobile_r25_server_patch import transform_model_catalog, transform_workshop


def host(source):
    source = transform_model_catalog(source)
    def replace(old, new):
        nonlocal source
        if source.count(old) != 1:
            raise ValueError('Unrecognized host regex baseline: ' + old[:70])
        source = source.replace(old, new, 1)
    replace('REGEX_REPLACE_MAX_CHARS = 240000', '''REGEX_REPLACE_MAX_BYTES = 8 * 1024 * 1024


def checked_regex_replacement(value: object) -> str:
    text = str(value if value is not None else "")
    if len(text.encode("utf-8")) > REGEX_REPLACE_MAX_BYTES:
        raise ValueError("界面模板（正则）单条替换内容不能超过 8 MiB；未保存，请缩小文件后重试")
    return text


def recover_legacy_regex_replacements(rules: list, extra: dict) -> list:
    """Repair only the provable old 240000-character truncation, without a DB migration.

    The retained original card is the same version, not a newer creator resource.
    Never replace edited text, change flags/order, resurrect deleted rules, or
    choose between conflicting source candidates.
    """
    if not any(isinstance(r, dict) and len(str(r.get("replace", ""))) == 240000 for r in rules):
        return rules
    candidates = []
    snapshot = extra.get("sillytavern_card")
    roots = [extra]
    if isinstance(snapshot, dict):
        roots.append(snapshot)
        if isinstance(snapshot.get("data"), dict):
            roots.append(snapshot["data"])
    for root in roots:
        extensions = root.get("extensions")
        if isinstance(extensions, dict):
            for key in ("regex_scripts", "TavernHelper_scripts", "tavern_helper_scripts"):
                if isinstance(extensions.get(key), list):
                    candidates.extend(extensions[key])
        if root is not extra and isinstance(root.get("regex_scripts"), list):
            candidates.extend(root["regex_scripts"])
    by_key = {}
    for index, candidate in enumerate(candidates):
        if not isinstance(candidate, dict):
            continue
        try:
            normalized = normalize_regex_scripts([dict(candidate, id=candidate.get("id") or f"regex-{index + 1}")])
        except ValueError:
            continue
        if not normalized:
            continue
        candidate = normalized[0]
        key = (candidate["id"], candidate["find"], candidate["flags"])
        by_key.setdefault(key, set()).add(candidate["replace"])
    restored = []
    for rule in rules:
        if not isinstance(rule, dict):
            restored.append(rule)
            continue
        text = str(rule.get("replace", ""))
        matches = {value for value in by_key.get((rule.get("id"), rule.get("find"), rule.get("flags", "")), ())
                   if len(text) == 240000 and len(value) > len(text) and value.startswith(text)}
        restored.append(dict(rule, replace=matches.pop()) if len(matches) == 1 else rule)
    return restored''')
    replace('str(raw.get("replaceString") if raw.get("replaceString") is not None else raw.get("replace") or raw.get("replacement") or "")[:REGEX_REPLACE_MAX_CHARS]',
            'checked_regex_replacement(raw.get("replaceString") if raw.get("replaceString") is not None else raw.get("replace") or raw.get("replacement") or "")')
    replace('"replace": replace[:REGEX_REPLACE_MAX_CHARS],', '"replace": checked_regex_replacement(replace),')
    replace('"replaceString": str(\n            raw.get("replace")', '"replaceString": checked_regex_replacement(\n            raw.get("replace")')
    replace('        )[:REGEX_REPLACE_MAX_CHARS],', '        ),')
    replace('meta["statusbar"] = statusbar_val.strip()[:REGEX_REPLACE_MAX_CHARS]', 'meta["statusbar"] = checked_regex_replacement(statusbar_val.strip())')
    replace('''            value = pattern.sub(lambda match: expand_silly_regex_replacement(replacement, match), value)
            if len(value) > REGEX_REPLACE_MAX_CHARS:
                value = value[:REGEX_REPLACE_MAX_CHARS]''', '''            value = checked_regex_replacement(pattern.sub(lambda match: expand_silly_regex_replacement(replacement, match), value))''')
    replace('''    regex_scripts = extra.get("regex_scripts")
    if not isinstance(regex_scripts, list):
        regex_scripts = []
    media_assets''', '''    regex_scripts = extra.get("regex_scripts")
    if not isinstance(regex_scripts, list):
        regex_scripts = []
    regex_scripts = recover_legacy_regex_replacements(regex_scripts, extra)
    media_assets''')
    replace('''        text = apply_regex_scripts(text, card or {})
        key = _dedupe_text_key(text)''', '''        # Persist source, never display-regex output. The SillyTavern runtime
        # owns display processing; a second pass can inject an HTML document
        # into its own trigger and expose the remaining source as Markdown.
        text = apply_regex_scripts(text, card or {}, source_only=True)
        key = _dedupe_text_key(text)''')
    replace('''def apply_regex_scripts(text: str, app: dict) -> str:
    value = str(text or "")
    for script in enabled_regex_scripts(app):''', '''def apply_regex_scripts(text: str, app: dict, *, source_only: bool = False) -> str:
    value = str(text or "")
    for script in enabled_regex_scripts(app):
        if source_only:
            # Follow native source-stage semantics. Display-only rules render
            # in the client, prompt-only rules belong to model input. Keep
            # source-transforming assistant rules working for ordinary cards.
            if script.get("markdownOnly") or script.get("promptOnly"):
                continue
            placements = script.get("placement") or [2]
            if 2 not in placements:
                continue''')
    return source


def workshop(source):
    source = transform_workshop(source)
    source = source.replace('if work_type in WORK_TYPES:\n            where.append("work_type=?"); args.append(work_type)',
        'if work_type in {"ui_template", "regex"}:\n            where.append("work_type in (\'ui_template\',\'regex\')")\n        elif work_type in WORK_TYPES:\n            where.append("work_type=?"); args.append(work_type)')
    source = source.replace('if work_type in {"mod", "preset", "regex"}:',
        'if work_type in {"mod", "preset", "regex"} or (work_type == "ui_template" and isinstance(content, dict) and "regex_scripts" in content):')
    source = source.replace('if work_type == "regex" and not isinstance', 'if work_type in {"regex", "ui_template"} and not isinstance')
    return source


def card_extra(source):
    source = source.replace('row.get("work_type") != "ui_template"', 'row.get("work_type") not in {"ui_template", "regex"}')
    return source.replace('get_version(version_id, "ui_template", work_id)', 'get_version(version_id, row["work_type"], work_id)')


def locked_assets(source):
    source = source.replace('    applied_ui: list[dict] = []', '    applied_ui: list[dict] = []\n    template_regex: list[dict] = []')
    source = source.replace('        snapshot = community.versions.snapshot(version_id, "ui_template", work_id)',
        '        work = community.get_work(work_id)\n        if not work or work.get("work_type") not in {"ui_template", "regex"}:\n            continue\n        snapshot = community.versions.snapshot(version_id, work["work_type"], work_id)')
    needle = '        experience = source.get("card_experience") if isinstance(source.get("card_experience"), dict) else {}'
    replacement = '''        rules = source.get("regex_scripts", [])
        for rule_index, raw_rule in enumerate(rules if isinstance(rules, list) else []):
            if not isinstance(raw_rule, dict) or not isinstance(raw_rule.get("findRegex"), str):
                continue
            rule = dict(raw_rule)
            rule["id"] = f"work-regex:{work_id}:{version_id}:{rule_index}"
            template_regex.append(rule)
''' + needle
    if needle not in source: raise ValueError('Unrecognized locked assets baseline')
    source = source.replace(needle, replacement)
    source = source.replace('    if applied_ui:\n', '''    if template_regex:
        # Idempotent hydration: keep author rules, replace only our own projection.
        authored = [rule for rule in extras.get("regex_scripts", []) if isinstance(rule, dict) and not str(rule.get("id", "")).startswith("work-regex:")]
        extras["regex_scripts"] = template_regex + authored
    if applied_ui:
''')
    return source


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('host','stage','patch'): parser.add_argument('--'+name,type=Path,required=True)
    args=parser.parse_args(); patches=[]
    for name,transform in [('ai_fengyue_local_server.py',host),('community_workshop.py',workshop),('card_extra_workshop.py',card_extra),('chat_mod_workshop.py',locked_assets)]:
        source=(args.host/'tools'/name).read_text(encoding='utf-8-sig');target=transform(source)
        compile(target,name,'exec')
        args.stage.mkdir(parents=True,exist_ok=True);(args.stage/name).write_text(target,encoding='utf-8',newline='\n')
        patches.append(''.join(difflib.unified_diff(source.splitlines(True),target.splitlines(True),fromfile='a/tools/'+name,tofile='b/tools/'+name)))
    args.patch.parent.mkdir(parents=True,exist_ok=True);args.patch.write_text(''.join(patches),encoding='utf-8',newline='\n')
    print('Generated cumulative R26 server patch; existing resource/version IDs preserved.')


if __name__=='__main__': main()
