# Homer upstream record

- Extension: SillyTavern-MemoryBooks
- Version: 8.2.2
- Upstream: https://github.com/aikohanasaki/SillyTavern-MemoryBooks
- Local source used for this bundled copy:
  `D:\SillyTavern Launcher GUI\data\st_data\default-user\extensions\SillyTavern-MemoryBooks`
- License: AGPL-3.0 (see `LICENSE` and `COPYRIGHT`)

Homer bundles the complete extension source and release assets, excluding only
the upstream `.git` metadata. Automatic updating is disabled in `manifest.json`
so a deployed Homer runtime cannot silently change behavior.

Homer uses the upstream release assets unchanged. Its bridge preselects the
extension setting that dismisses the optional Chat TopInfoBar installation
notice because Homer provides its own top bar. The core Memory Books UI and
memory operations are unchanged.
