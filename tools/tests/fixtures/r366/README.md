# R366 isolated server regression code

These are code-only fixtures, not a server package and not account fixtures.
`community_workshop.py` and `card_version_workshop.py` retain the reviewed
pre-patch modules byte-for-byte; `provider_runtime_baseline.py` retains only
three exact legacy methods and the authenticated runtime-state route excerpt.
It deliberately cannot run as a complete provider. `manifest.json` fixes their
bytes. No credentials, sessions, API keys, models, user rows or databases are
included. Tests use in-memory SQLite and synthetic identifiers only.

Default tests now run on another computer/CI without the original private
Windows directories. For an additional integration check against the owner's
maintained, unpatched source, explicitly set `HOMER_WORKSHOP_SOURCE` and
`HOMER_R366_PROVIDER_SOURCE`. Passing these fixtures is not a live deployment,
full authentication implementation, provider latency or production-data test.
