"""Package small local catalogue previews only; media bodies remain demand-loaded."""
import hashlib
import json
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parents[1]
data = root / 'frontend/app/assets/data'
catalog = json.loads((data / 'chatarchive-theme.json').read_text(encoding='utf-8'))
manifest = json.loads((data / 'chatarchive-pack.json').read_text(encoding='utf-8'))
target = root / 'frontend/app/assets/images/archive-preview'
target.mkdir(parents=True, exist_ok=True)
total=0
with zipfile.ZipFile(root / 'output/chatarchive-r359/ChatArchive-1.1.11-local-media.hcap') as source:
    for role in catalog['roles']:
        name=f"preview/{role['id']}.webp"
        if name not in manifest['entries']: continue
        content=source.read(name)
        assert hashlib.sha256(content).hexdigest()==manifest['entries'][name]['sha256']
        (target/f"{role['id']}.webp").write_bytes(content)
        total+=len(content)
print(json.dumps({'previews':len(list(target.glob('*.webp'))),'bytes':total}))
