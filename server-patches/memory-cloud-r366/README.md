# R366 private memory backup, existing runtime-state interface

**Not deployed.** An APK/source merge alone does not enable cloud recovery.
The phone remains usable offline and keeps its authoritative memory outbox;
uninstall removes unuploaded phone-private data. Do not claim recovery of data
that never reached an upgraded server.

The optional `variables.homer_memory_book` namespace contains an exact-scope
versioned envelope and SHA-256 of its UTF-8 JSON book. Existing authenticated
`/console/api/web/dialogue/runtime-state` GET/POST routes remain in use. No
author lorebook/global plugin settings are migrated. Omitted namespace = legacy
writer, preserve existing memory. Explicit empty entries = clear, through CAS.

Deploy separately, only after review/authorization:

1. Back up SQLite consistently, including WAL. Preserve all user data.
2. Run `python tools/export_r366_memory_server.py --source <maintained-provider.py>
   --destination <new-handoff-directory>`. The exporter reads source, rejects
   changed boundaries, and produces only an incremental patch plus helper.
3. Review and `git apply --check backend.patch` in the maintained checkout;
   place `homer_memory_storage.py` beside `ai_fengyue_local_server.py`.
   Do not replace the whole provider or reapply unrelated cumulative patches.
4. Syntax-check and run `python tools/tests/test_memory_cloud_r366.py`, setting
   `HOMER_R366_PROVIDER_SOURCE` to the maintained unpatched fixture source.
5. Apply/restart through the existing maintenance process. Use synthetic
   owned conversations to verify authenticated scope, GET receipt, same-commit
   repeat, old-client preservation, stale CAS 409 and complete fresh restore.

The provider's existing RLock and SQLite transaction protect memory CAS.
Accepted replacements retain ten exact previous private snapshots in an
additive `homer_memory_backups` table. Legacy users without this namespace
receive no memory migration/writes. Existing other runtime fields retain their
behavior. Variables remain capped at 512,000 UTF-8 bytes; oversized updates
fail before SQL, never truncate. Budget backup disk and review retention.

Client saves first commit the real existing extension-settings outbox. Private
world mirrors are derived projections repaired from that durable source.
Uploads are opportunistic/realtime storage-only; generation is never replayed.
CAS conflict obtains one authenticated latest token and retries the phone's
unchanged memory once; a second race remains pending. ACK must echo the exact
scope, digest/change id, complete protocol and opaque server version. An
unupgraded server cannot turn HTTP 200 into a false backup acknowledgement.

Rollback: keep the preservation/CAS provider active while rolling back a
client. Old clients may edit their other variables but cannot erase this key.
No public backup listing or unauthenticated restore endpoint is introduced.
