"""Run the current client against the existing isolated PC test database.

No production services, database reset, or fake API responses are involved.
"""
import argparse
import importlib.util
import ipaddress
import sys
from pathlib import Path
from urllib.parse import urlparse


def configure(backend_root, host, public_url=None):
    address = ipaddress.ip_address(host)
    if address.version != 4 or not (address.is_private or address.is_loopback) or address.is_unspecified:
        raise ValueError("Use an explicit private LAN or loopback IPv4 address")
    spec = importlib.util.spec_from_file_location("homer_offline_manager", backend_root / "tools/offline_dev.py")
    manager = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(manager)
    client = Path(__file__).resolve().parents[1]
    manager.PROXY_HOST = host
    manager.PUBLIC_BASE_URL = f"http://{host}:8080"
    manager.SILLYTAVERN_PUBLIC_URL = manager.PUBLIC_BASE_URL + "/module/dialogue"
    manager.SILLYTAVERN_DIR = client / "sillytavern-runtime"
    manager.SILLYTAVERN_SERVER = manager.SILLYTAVERN_DIR / "server.js"
    manager.SILLYTAVERN_NODE_MODULES = manager.SILLYTAVERN_DIR / "node_modules"
    # Do not retarget the older launcher's junctions.
    manager.SILLYTAVERN_ALIAS_ROOT = manager._windows_alias_root() / "current-client"
    manager.SILLYTAVERN_LAUNCH_DIR = manager.SILLYTAVERN_ALIAS_ROOT / "runtime"
    manager.SILLYTAVERN_LAUNCH_STATE_DIR = manager.SILLYTAVERN_ALIAS_ROOT / "state"
    manager.SILLYTAVERN_LAUNCH_DATA_DIR = manager.SILLYTAVERN_LAUNCH_STATE_DIR / "sillytavern-data"
    original_command = manager.process_command

    def command(role):
        result = original_command(role)
        if role == "proxy":
            result[result.index("--frontend") + 1] = str(client / "frontend")
            # The proxy serves runtime assets directly. Updating only the Node
            # launch directory leaves HTTP clients running a different old tree.
            public = str(client / "sillytavern-runtime" / "public")
            if "--dialogue-public" in result:
                result[result.index("--dialogue-public") + 1] = public
            else:
                result.extend(["--dialogue-public", public])
            if not address.is_loopback:
                result.append("--allow-network")
        return result

    manager.process_command = command
    if public_url:
        origin = urlparse(public_url)
        if origin.scheme != 'https' or not origin.hostname or origin.username or origin.password or origin.path not in ('','/') or origin.query or origin.fragment:
            raise ValueError('Public test URL must be an HTTPS origin')
        public_url = public_url.rstrip('/')
        original_environment = manager.offline_environment

        def environment(*, include_credentials=False):
            env = original_environment(include_credentials=include_credentials)
            env.update(PUBLIC_BASE_URL=public_url,
                       SILLYTAVERN_PUBLIC_URL=public_url+'/module/dialogue',
                       ALLOWED_CORS_ORIGINS=public_url,
                       AUTH_COOKIE_SECURE='1')
            return env

        manager.offline_environment = environment
    return manager


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("start", "status", "stop"))
    parser.add_argument("--backend-root", type=Path, required=True)
    parser.add_argument("--host", required=True)
    parser.add_argument("--public-url", help="HTTPS phone-test origin; local health checks stay on loopback")
    args = parser.parse_args()
    manager = configure(args.backend_root.resolve(), args.host, args.public_url)
    sys.argv = [sys.argv[0], args.action]
    raise SystemExit(manager.main())
