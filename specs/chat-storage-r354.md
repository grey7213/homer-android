# R354 chat persistence repair

Delivery version is 355 / 1.18.2: upstream released 354 / 1.18.1 with personal
backup support while this repair was in progress. That feature and its patch are
preserved; this repair is incremental after all seven upstream web patches.

Scope: complete phone-owned canonical history, offline runtime/session resources,
durable upload queue, CAS-protected cloud backup and live/opportunistic sync.
No production data mutation during development.

1. Complete: inspect R353 APK, client save/read paths and server snapshot replacement.
2. Complete: protocol and transactional provider + durable consumer.
3. Complete: regress stale devices, lost ACKs, legacy clients, >500/>1000 messages,
   concurrent edits, restart, account isolation, conflict recovery and conditional reads.
4. Complete: local-first whole-runtime/clean patch/build verification; device and
   cold-start performance boundaries remain explicit below.
5. Active: reviewed branch submission + PR; distinguish deployment from APK merge.

User clarification: phone-owned local-first history is authoritative. Offline
view/edit/save and local rollback must not await or be disabled by cloud. Active
step: durable complete local session + history retention, with live upload and
opportunistic replay on connectivity/foreground. Cloud conflicts retain remote
backup and local pending progress without blocking the phone; automatically upload
the actual pending phone edit after one verified token rebase, never force a fork.
Revalidate all
prior gates after these changes. Previously reported results apply to the earlier
CAS-first implementation, not this new local-first acceptance.

Acceptance: cached histories open/edit/save/delete/rollback offline, with full
messages/card/settings/regex, without waiting for cloud tokens or a loading screen.
ACK never evicts phone data; cloud refresh never replaces phone progress. Pending
phone writes upload live and retry on reconnect/foreground/30s while active. CAS
rejects stale writes; one verified-token retry backs up the previous cloud history
transactionally before accepting the phone edit. Partial reads are never saved as
complete; delayed ACK never clears newer edits; read-only visits do not upload.
Unprepared histories/assets and online model generation still require network.
Every change to
messages (including rollback/delete through other routes) changes its storage token.

Risks: server/client release order, delayed ACKs while newer local edits exist,
long histories, trigger migration, and existing main changes. Install server changes
before the client, back up production DB first, do not infer recovery of already lost
records without a real server backup. Tests use synthetic isolated databases only.

Implemented: scoped opaque CAS and idempotent commits; transactional prior-body
backups; mutation triggers; no read/write row truncation; explicit idempotent fork;
pending-lineage ACK rebasing; count-checked complete cache; authenticated conditional
reuse; no POST just for loading history. Only the existing account is authoritative.

Local-first verification: the CI-shaped Node suite passed 1,805 tests with one
existing opt-in benchmark skipped. Python 3.13 with the reviewed R41 server source
passed 73 tests (18 provider/export and 55 current card/billing/image regressions).
The maintained D: generation helper is older, so it is not used to replace the
reviewed R41 billing implementation. Provider package/hash/export/apply-check pass.
Android debug tests (94), lint and assembly passed. APK 355 contains 1,760 assets
and all 524 frontend files; source/raw/output hashes match. The seven incremental modules match the clean tree
after applying all eight ordered patches, normalizing only CRLF/LF.

Actual Chromium IndexedDB tests at 390x844 and 1440x900 retain 126 archives,
1,101 messages, variables, model catalog and default/per-model regex after reload.
Synthetic HTTP/transactional SQLite tests with the shipping save/delete/rollback
functions pass offline mutation, reopening, phone authority, reconnect/CAS retry,
prior-cloud backup and exact ACK fencing, without unexpected script/network errors.
Whole shipping runtime tests additionally verify the complete initialized engine,
real chat rows, card description, extension settings, sampling controls and rendered
regex on API-denied reload. Online generation still uses the real provider route;
offline/unavailable-provider failures do not create replies or replay generation.
Read-only history opening does not POST chat bodies. Extension migration/default
initialization may save the conversation's normalized runtime state; this is not
an old-history overwrite and must not disable legitimate card-script saves.

Whole-runtime testing found and fixed an upstream welcome-panel race: its late
template could append welcome messages after the embedded history was restored.
Embedded startup now skips that standalone welcome surface. Captured context/scope
guards also prevent a late rollback/delete/settings operation from changing another
account's state, including upstream reuse of the same chat array.

Boundaries: no connected Android device (`adb devices` empty), no production
database writes, no affected user's recovery tested. Browser timings are not phone
timings. Isolated whole-document browser startup is still roughly 10-14 seconds,
including extension initialization, even with APIs denied and bundled assets
available; this is not an Android retained-WebView switch measurement and must
not be labelled instant. Warm full-runtime browser switches with 1,101 messages
measured approximately 3.3-4.2 seconds, same-card and different-card, with one engine
initialization and zero session/sync HTTP requests during those offline switches.
Optional token-statistics/media APIs still attempt requests and report offline
warnings; no bundle assets fail and no malformed SVG/page errors remain.
The change removes cloud waits from prepared local-history
reads, not all engine initialization work. Current production
needs the incremental Python module/route deployment before APK 355 is usable for
protected saves. Old clients receive 428, preserving local bytes, not an unsafe
compatibility override. Maintenance/release ordering and disk budget are explicit
in server-patches/chat-storage-r354-v2/README.md. No merge or publisher run by this
contribution; submitting the PR does not mean the server was updated.

Reproducible commands: Node `--experimental-vm-modules --test
--test-concurrency=1 tools/tests/*.test.mjs tools/tests/*.test.cjs`; Python 3.13
`-m unittest tools.tests.test_homer_chat_storage tools.tests.test_r354_export
tools.tests.test_homer_session_cards tools.tests.test_mobile_r32_billing
tools.tests.test_mobile_r33_images` with the reviewed R41 source;
Gradle `testDebugUnitTest lintDebug assembleDebug`; `tools/verify_apk_assets.py`;
`r354_full_runtime_server.py` + `r354_full_runtime_checks.py` (cold/offline/warm).
