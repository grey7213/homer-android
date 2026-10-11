"""Real shipping runtime, loopback only, isolated synthetic Memory Books data."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/memory-private-20261011'
OUT.mkdir(parents=True, exist_ok=True)
config = OUT / 'config.yaml'
data = OUT / 'data'
config.write_text(f'''dataRoot: {data.as_posix()}
port: 8802
listen: false
protocol:
  ipv4: true
  ipv6: false
browserLaunch:
  enabled: false
enableUserAccounts: false
basicAuthMode: false
disableCsrfProtection: true
whitelistMode: true
whitelist:
  - 127.0.0.1
  - ::1
hostWhitelist:
  enabled: false
homerBridge:
  enabled: false
extensions:
  enabled: true
  autoUpdate: false
  models:
    autoDownload: false
enableDownloadableTokenizers: false
enableServerPlugins: false
enableServerPluginsAutoUpdate: false
logging:
  enableAccessLog: false
  minLogLevel: 1
''', encoding='utf-8')
node = subprocess.Popen(['node', 'server.js', '--configPath', str(config),
                         '--dataRoot', str(data), '--port', '8802'],
                        cwd=ROOT / 'sillytavern-runtime')
try:
    raise SystemExit(node.wait())
finally:
    if node.poll() is None:
        node.terminate()
        node.wait(timeout=10)
