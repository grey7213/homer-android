"""Generate PRIVATE per-character packs. The full pack is an optional offline library."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'frontend/app/assets/data'
OUT = ROOT / 'output/chatarchive-r359'
catalog = json.loads((DATA / 'chatarchive-theme.json').read_text(encoding='utf-8'))
manifest = json.loads((DATA / 'chatarchive-pack.json').read_text(encoding='utf-8'))
PREFIX = '/media-cache/card-assets/ready/archive-local-1111/'
packs_dir = OUT / '人物素材包'; packs_dir.mkdir(exist_ok=True)
packs = [{'id': 'full', 'sha256': manifest['sha256'], 'bytes': manifest['bytes'], 'entries': list(manifest['entries'])}]
with zipfile.ZipFile(OUT / 'ChatArchive-1.1.11-local-media.hcap') as full:
    office = next(row for row in catalog['backgrounds'] if row['id'] == 'common/BG_MainOffice')
    theme_music = next((row for row in catalog['music'] if row['id'] == 'Theme_12'), catalog['music'][0])
    common = {'NOTICE.txt', office['url'][len(PREFIX):], theme_music['url'][len(PREFIX):]}
    common.update(row['url'][len(PREFIX):] for row in catalog['emotionAudio'])
    for role in catalog['roles']:
        paths = set(common)
        if role['preview']: paths.add(role['preview'][len(PREFIX):])
        for variant in role['variants']:
            paths.update(url[len(PREFIX):] for url in [variant['atlas'], variant['skeleton'], *variant['textures']])
        default = next((row for row in catalog['backgrounds'] if row['id'] == role['background']), office)
        paths.add(default['url'][len(PREFIX):])
        destination = packs_dir / f"{role['name']}-{role['id']}.hcap"
        with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as pack:
            for path in sorted(paths):
                info = zipfile.ZipInfo(path, date_time=(2026, 10, 9, 0, 0, 0))
                pack.writestr(info, full.read(path))
        with destination.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        packs.append({'id': role['id'], 'sha256': digest, 'bytes': destination.stat().st_size, 'entries': sorted(paths)})
manifest['packs'] = packs
catalog['resourcePacks'] = [{'id': pack['id'], 'bytes': pack['bytes'],
    'backgrounds': [row['id'] for row in catalog['backgrounds'] if row['url'][len(PREFIX):] in pack['entries']],
    'music': [row['id'] for row in catalog['music'] if row['url'][len(PREFIX):] in pack['entries']]} for pack in packs]
(DATA / 'chatarchive-theme.json').write_text(json.dumps(catalog, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
(DATA / 'chatarchive-pack.json').write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
evidence = {'perCharacterPacks': len(packs) - 1, 'smallestBytes': min(pack['bytes'] for pack in packs[1:]),
            'largestBytes': max(pack['bytes'] for pack in packs[1:]),
            'yuukaBytes': next(pack['bytes'] for pack in packs if pack['id'] == 'yuuka'), 'fullOptionalBytes': manifest['bytes']}
(OUT / 'split-evidence.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
print(json.dumps(evidence))
