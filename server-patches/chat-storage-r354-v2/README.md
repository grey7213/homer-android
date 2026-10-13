# R354 transactional chat history

Deploy this Python change **before** the 355 / 1.18.2 APK/client patch (the R354
repair work was renumbered after upstream released 354). An APK merge
alone cannot install these server protections. The Node bridge already forwards
`chat_version` and the new POST fields unchanged; no proxy rewrite is required.

1. Take a consistent SQLite online backup (SQLite backup API or stopped-service
   copy including required WAL state). Preserve the pre-update APK/data on devices
   reporting missing progress. Never clear their app storage or reset the database.
2. In the maintained server source checkout, review `backend.patch`. It changes
   only the chat storage method, authenticated session message read, and sync route.
   Run `git apply --check <backend.patch>`; if it does not match, stop and run
   `python tools/export_r354_server.py --source <maintained-server.py>
   --destination <new-empty-handoff-directory>` from this Android checkout.
   The exporter rejects changed boundaries. Review its fresh diff; do not replace
   the whole Python server with an old contributor copy or reapply cumulative R41.
3. Apply the reviewed incremental patch; place `homer_chat_storage.py` alongside
   `tools/ai_fengyue_local_server.py`. Syntax-check both and restart through the
   existing service workflow. Run the synthetic storage tests before deployment.
4. GET a test-owned session: `storage.protocol=2`, `complete=true`, correct full
   count and opaque version. Save with `storage_version` and a stable captured
   `storage_commit_id`. Repeat that exact POST: same result, no second rewrite.
   Stale version -> 409; unsafe old client -> 428; neither changes stored messages.
5. Release APK 355 using the existing package and established release certificate.
   Inspect any active data patch slots as usual; do not clear user databases.

Migration is additive and happens transactionally on first authenticated access.
Triggers change the token for edits/deletes/rollback made through other SQL routes.
No existing message is truncated. A fresh full read returns all rows; a verified
matching `chat_version` returns `unchanged=true` and no message retransmission.
The phone retains complete local histories without ACK eviction and opens those
without waiting for cloud. A phone with no complete archive fetches one first.
Matching conditional reads remain available for authorized refresh. Merely
opening a history does not POST it back or replace local progress.

An accepted overwrite stores the previous complete body before modifying rows,
atomically, retaining ten backups per conversation. Budget disk accordingly:
the 10 MB request cap implies up to roughly 100 MB backups per large conversation,
plus SQLite/WAL overhead. Monitor size and plan a retention/archive policy before
large-scale rollout. All receipts and backups are account scoped. No new public
backup listing or unauthenticated restore endpoint is added.

409 keeps pending local bytes; for an actual pending phone edit, the client reads
a fresh authenticated cloud token and retries CAS once. The accepted write backs
up the old cloud body transactionally. A second racing conflict stays pending for
the next sync opportunity; it does not block local use or duplicate histories.
Missing legacy version requires the same verified full read before migration.
428 from an unupgraded server stays pending. Older clients must update; weakening the CAS check to
keep unsafe clients writing defeats the fix. Coordinate this maintenance window.

Rollback: leave the protected provider active while reverting a client if needed.
Do not revert to the unsafe whole-snapshot writer. These backups protect writes
after deployment; restoring data already lost requires an actual pre-loss backup
and account-specific review. No real user history was overwritten in development.
