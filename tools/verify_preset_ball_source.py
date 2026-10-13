"""Verify literal upstream provenance and real generated source-map parity."""
import hashlib
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
MODULE=ROOT/'sillytavern-runtime/public/scripts/extensions/homer-preset-ball'
def main():
    # Portable reference hashes copied from the recovered literal source-map manifest.
    provenance=json.loads((ROOT/'specs/preset-ball-provenance.json').read_text(encoding='utf-8'))
    for record in provenance['upstream']:
        assert hashlib.sha256((MODULE/'upstream'/record['name']).read_bytes()).hexdigest()==record['sha256'],record['name']
    sourcemap=json.loads((MODULE/'index.build.js.map').read_text(encoding='utf-8'))
    own=[]
    for name,content in zip(sourcemap['sources'],sourcemap['sourcesContent']):
        if name.startswith('src/'):
            expected=(MODULE/name).read_text(encoding='utf-8').replace('\r\n','\n')
            assert content.replace('\r\n','\n')==expected,name
            own.append(name)
    assert {'src/App.vue','src/PresetView.vue','src/PromptItem.vue','src/BatchToolbar.vue'}.issubset(set(own))
    manifest=json.loads((MODULE/'build-manifest.json').read_text(encoding='utf-8'))
    for item in manifest['inputs']:
        assert hashlib.sha256((MODULE/item['name']).read_bytes()).hexdigest()==item['sha256'],item['name']
    for item in manifest['outputs']:
        assert hashlib.sha256((MODULE/item['name']).read_bytes()).hexdigest()==item['sha256'],item['name']
    print(json.dumps({'upstream_components':len(provenance['upstream']),'mapped_own_sources':len(set(own)),
        'map_contents_match':True,'input_and_bundle_hashes_match':True}))
if __name__=='__main__':main()
