"""Launch the shipping Node runtime with an isolated synthetic-only data root.

Use with webapp-testing/scripts/with_server.py or run in a separate terminal.
All generated settings, cookies and logs belong under ignored output/.
"""
from pathlib import Path
import argparse
import subprocess

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--port", type=int, default=8796)
args = parser.parse_args()
if not 1024 <= args.port <= 65535:
    parser.error("Use an unprivileged loopback port")
out = ROOT / "output"
out.mkdir(exist_ok=True)
data = out / "r354-full-runtime-data"
config = out / "r354-full-runtime-config.yaml"
config.write_text(f"""dataRoot: {data.as_posix()}
port: {args.port}
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
""", encoding="utf-8")
node = subprocess.Popen(["node", "server.js", "--configPath", str(config),
    "--dataRoot", str(data), "--port", str(args.port)], cwd=ROOT / "sillytavern-runtime")
try:
    raise SystemExit(node.wait())
finally:
    if node.poll() is None:
        node.terminate()
        node.wait(timeout=10)
