"""Build a PRIVATE local acceptance pack from the user's verified 1.1.11 exports.

No original executable code, protected 1.2.6 data, player data or network reads.
Generated outputs are data, not a recovered proprietary project. Do not publish
the media pack without obtaining redistribution rights from its rights holders.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import zipfile

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path("D:/网站/ChatArchive角色卡/ChatArchive_原版资源库")
CARD = Path("D:/网站/ChatArchive角色卡/可导入角色卡/ChatArchive_基沃托斯群像_V2.json")
BINDINGS = Path("D:/网站/chatarchive_reverse/game_ui_plugin_source/bindings/worldbook-bindings.json")
PREVIEWS = Path("D:/网站/ChatArchive角色卡/可直接导入惑梦/package-source/assets/portrait")
BASE = "/media-cache/card-assets/ready/archive-local-1111/"


def compact(value):
    return "".join(str(value).split()).lower()


def build(output):
    output.mkdir(parents=True, exist_ok=True)
    target = ROOT / "frontend/app/assets/data"
    target.mkdir(parents=True, exist_ok=True)
    index = json.loads((SOURCE / "资源索引.json").read_text(encoding="utf-8"))
    bindings = json.loads(BINDINGS.read_text(encoding="utf-8"))
    card = json.loads(CARD.read_text(encoding="utf-8"))["data"]
    entries = card["character_book"]["entries"]
    profiles = {compact(entry["comment"]): entry for entry in entries[1:]}
    previews = {compact(file.stem): file for file in PREVIEWS.glob("*.png")}
    source_files, generated, hashes = {}, {}, {}

    def include(relative):
        # Only known data formats. No HTML, scripts or executable imports.
        path = (SOURCE / relative).resolve()
        if not path.is_relative_to(SOURCE.resolve()) or not path.is_file():
            raise ValueError(f"Missing/out-of-scope media: {relative}")
        ext = path.suffix.lower()
        if ext not in {".png", ".jpg", ".webp", ".ogg", ".wav", ".atlas", ".skel"}:
            raise ValueError(f"Unexpected format: {relative}")
        archive_path = "media/" + relative.replace("\\", "/")
        if archive_path not in source_files:
            source_files[archive_path] = path
            digest = hashlib.file_digest(path.open("rb"), "sha256").hexdigest()
            hashes[archive_path] = {"bytes": path.stat().st_size, "sha256": digest}
        return BASE + archive_path

    variants = {}
    for item in index["portraitVariants"]:
        atlas_file = SOURCE / item["atlas"]
        lines = atlas_file.read_text(encoding="utf-8-sig").splitlines()
        pages = [line.strip() for i, line in enumerate(lines)
                 if line.strip().lower().endswith((".png", ".jpg"))
                 and (i == 0 or not lines[i - 1].strip())]
        if not pages:
            raise ValueError(f"Atlas has no pages: {atlas_file}")
        textures = [include(str(Path(item["atlas"]).parent / page)) for page in pages]
        variants.setdefault(item["roleId"], []).append({
            "id": item["variant"], "atlas": include(item["atlas"]),
            "skeleton": include(item["skeleton"]), "textures": textures,
            "spineVersion": item["spineVersion"],
            "animations": [animation["name"] for animation in item["animations"]],
            "skins": item["skins"],
        })
    backgrounds = [{"id": item["id"], "url": include(item["file"]),
                    **hashes["media/" + item["file"]]} for item in index["backgrounds"]]
    music = [{"id": item["id"], "url": include(item["file"]),
              **hashes["media/" + item["file"]]} for item in index["bgm"]]
    emotion_audio = [{**item, "url": include(item["file"])} for item in index["emotionAudio"]]
    roles = []
    for role_id, rows in variants.items():
        names = [(name, value) for name, value in bindings["roles"].items() if value["roleId"] == role_id]
        sample = next(item for item in index["portraitVariants"] if item["roleId"] == role_id)
        name, binding = names[0] if names else (sample["displayName"], {})
        profile = profiles.get(compact(name)) or profiles.get(compact(sample["displayName"]))
        preview = previews.get(compact(name)) or previews.get(compact(sample["displayName"]))
        thumb = ""
        if preview:
            image = Image.open(preview).convert("RGBA")
            image.thumbnail((320, 480))
            buffer = io.BytesIO(); image.save(buffer, format="WEBP", quality=85)
            file = f"preview/{role_id}.webp"; generated[file] = buffer.getvalue(); thumb = BASE + file
        roles.append({"id": role_id, "name": name, "aliases": profile.get("keys", []) if profile else [],
                      "academy": binding.get("academy", "schale"), "profile": profile["content"] if profile else "",
                      "defaultVariant": binding.get("defaultVariant", rows[0]["id"]),
                      "background": binding.get("defaultBackground", "common/BG_MainOffice"),
                      "preview": thumb, "variants": rows})
    catalog = {"version": 1, "themeId": "kivotos-1111", "sourceVersion": "1.1.11",
               "implementation": "独立重建；非恢复的 1.2.6 原版工程", "roles": roles,
               "locations": bindings["locations"], "backgrounds": backgrounds, "music": music,
               "emotionAudio": emotion_audio, "worldbook": card["character_book"],
               "world": entries[0]["content"], "systemPrompt": card["system_prompt"],
               "opening": card["first_mes"], "personality": card["personality"],
               "sourceCardSha256": hashlib.sha256(CARD.read_bytes()).hexdigest()}
    # All plain-text role data is small and local in the APK; media is NOT.
    (target / "chatarchive-theme.json").write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    generated["NOTICE.txt"] = ("PRIVATE local acceptance media only. Source ChatArchive 1.1.11 user-provided exports.\n"
        "NOT 1.2.6, not original recovered source. No redistribution grant has been established.\n"
        "Blue Archive/Spine artwork and trademarks remain with their rights holders.\n").encode()
    for path, content in generated.items():
        hashes[path] = {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
    zip_path = output / "ChatArchive-1.1.11-local-media.hcap"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as pack:
        for name in sorted(source_files):
            pack.write(source_files[name], name)
        for name in sorted(generated):
            pack.writestr(name, generated[name])
    with zip_path.open("rb") as stream:
        pack_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    manifest = {"version": 1, "sourceVersion": "1.1.11", "sha256": pack_hash,
                "bytes": zip_path.stat().st_size, "entries": hashes}
    (target / "chatarchive-pack.json").write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    report = {"roles": len(roles), "playableProfiles": sum(bool(role["profile"]) for role in roles),
              "missingProfiles": [role["name"] for role in roles if not role["profile"]],
              "missingPreviews": [role["name"] for role in roles if not role["preview"]],
              "portraitVariants": sum(len(role["variants"]) for role in roles),
              "backgrounds": len(backgrounds), "music": len(music), "emotionAudio": len(emotion_audio),
              "packBytes": manifest["bytes"], "packSha256": pack_hash}
    (output / "build-evidence.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("--output", type=Path, required=True)
    build(parser.parse_args().output)
