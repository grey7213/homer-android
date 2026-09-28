"""Export the R30 delta against exact saved R29 input; no checkout mutation."""
from pathlib import Path
import subprocess
import tempfile
from export_r29_delivery import diff, text

ROOT=Path(__file__).resolve().parents[1]
TREE=ROOT/'.web-cache/tree'
BASE=ROOT/'output/mobile-r30/baseline'
PATHS=['frontend/admin.html','frontend/assets/js/admin-app.js','frontend/assets/js/admin-dialogue.js',
       'frontend/assets/css/admin-dialogue.css','sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js',
       'sillytavern-runtime/public/script.js']

def main():
    patch=''.join(diff(path,text(BASE/path),text(TREE/path)) for path in PATHS)
    target=ROOT/'web-patches/20260927-0002-admin-runtime-reuse-r30.patch'
    target.write_text('# Apply after 20260927-0001-regex-admin-preview-diagnostics-r29.patch.\n\n'+patch,encoding='utf-8',newline='\n')
    subprocess.run(['git','-C',str(TREE),'apply','--reverse','--check',str(target)],check=True)
    with tempfile.TemporaryDirectory(prefix='homer-r30-') as temp:
        folder=Path(temp)
        for path in PATHS:
            dest=folder/path;dest.parent.mkdir(parents=True,exist_ok=True)
            dest.write_text(text(BASE/path),encoding='utf-8',newline='\n')
        subprocess.run(['git','apply','--check',str(target)],cwd=folder,check=True)
        subprocess.run(['git','apply',str(target)],cwd=folder,check=True)
        for path in PATHS:assert text(folder/path)==text(TREE/path),path
    print('R30: 6-file delta; forward apply and byte-content comparison plus reverse check passed.')

if __name__=='__main__': main()
