"""Package only task-owned source, pinned deltas and sanitized verification."""
import hashlib
import json
import shutil
import subprocess
import zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
DEST=Path('D:/网站/预设悬浮球源码移植验收-20261012')
MODULE=ROOT/'sillytavern-runtime/public/scripts/extensions/homer-preset-ball'
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def main():
    DEST.mkdir(parents=True,exist_ok=True)
    apk=ROOT/'android-app/app/build/outputs/apk/debug/app-debug.apk'
    review=DEST/'惑梦-预设悬浮球源码移植-本地验收.apk'
    if review.exists():raise ValueError('Existing delivered APK is never silently replaced')
    shutil.copyfile(apk,review)
    archive=DEST/'绘梦预设悬浮球-惑梦源码移植包.zip'
    if archive.exists():raise ValueError('Existing delivered source archive is never silently replaced')
    entries={}
    def file(path,name):entries[name]=path
    def folder(path,prefix):
        for p in path.rglob('*'):
            if p.is_file() and not any(n in p.parts for n in ['node_modules','__pycache__','.git']):file(p,prefix+'/'+p.relative_to(path).as_posix())
    file(ROOT/'docs/preset-ball-local-delivery-20261012.md','README.md')
    file(ROOT/'web-patches/20261012-preset-ball-r367.patch','web-patches/20261012-preset-ball-r367.patch')
    folder(MODULE,'module-source')
    folder(ROOT/'tools/preset-ball-build','tools/preset-ball-build')
    folder(ROOT/'server-patches/preset-ball-r367','server-patches/preset-ball-r367')
    for name in ['export_preset_ball_server.py','export_preset_ball_web.py','verify_preset_ball_patch_chain.py','verify_preset_ball_source.py','verify_apk_assets.py']:
        file(ROOT/'tools'/name,'tools/'+name)
    for name in ['preset-ball-controller.test.mjs','preset-ball-generation-fence.test.mjs','preset-ball-fixture.html','preset_ball_browser.py','preset_ball_server_contract.py']:
        file(ROOT/'tools/tests'/name,'tools/tests/'+name)
    file(ROOT/'specs/preset-ball-provenance.json','specs/preset-ball-provenance.json')
    file(ROOT/'specs/preset-ball-transplant-20261012.md','specs/preset-ball-transplant-20261012.md')
    for name in ['browser-report.json','patch-chain-report.json','panel-390.png','light-390.png']:
        file(ROOT/'output/preset-ball-r367'/name,'verification/'+name)
    reference=Path('C:/CodexWork/dream-preset-transplant-20261012/recovered')
    file(reference/'remote-preset-module.js','reference/original-CDN-preset-module.js')
    folder(reference/'source-map-components','reference/original-components')
    native=subprocess.run(['git','diff','--binary','--full-index','--','android-app/app/build.gradle'],cwd=ROOT,capture_output=True,check=True).stdout
    manifest={'apk':{'name':review.name,'bytes':review.stat().st_size,'sha256':digest(review),'package':'org.nebula.horizon.composeai.presetreview','versionCode':366},
      'source_files':[{'path':name,'bytes':p.stat().st_size,'sha256':digest(p)} for name,p in sorted(entries.items())],
      'deployed':False,'submitted':False,'device_tested':False}
    with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for name,p in sorted(entries.items()):z.write(p,name)
        z.writestr('native-build.patch',native)
        z.writestr('delivery-manifest.json',json.dumps(manifest,ensure_ascii=False,indent=2))
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
        for record in manifest['source_files']:assert hashlib.sha256(z.read(record['path'])).hexdigest()==record['sha256']
    (DEST/'校验与交付记录.json').write_text(json.dumps({**manifest,'source_zip':{'name':archive.name,'bytes':archive.stat().st_size,'sha256':digest(archive)}},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'apk':str(review),'apk_sha256':digest(review),'source_zip':str(archive),'source_zip_bytes':archive.stat().st_size,'source_files':len(entries)},ensure_ascii=False))
if __name__=='__main__':main()
