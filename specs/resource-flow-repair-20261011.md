# Resource / farm / comment repair handoff

## Execution intent

Repair actual final-state journeys rather than cosmetic success messages:
private preset / regex cancel then confirm deletion followed by a fresh search;
Android export to a user-selected, actually written importable file;
farm harvest whose plots and unified account balance agree with committed server
state; account/post/environment-scoped comment drafts surviving leave/reentry
and failed submit, cleared only after confirmed submit. Preserve unrelated work,
role-card snapshots, account privacy and production data. No commit or deployment.

## Confirmed causes and changes

- CP07: real backend `CommunityStore.list_works(scope='mine')` omitted a deleted
  filter. Owner/admin detail and version checks also allowed deleted resources.
  Client now excludes only explicit persisted `status='deleted'`, requires an
  explicit deletion ACK, and invalidates resource/draft cache after that ACK.
  The reviewed backend patch also rejects deleted detail, version, update, and
  favorite access while preserving pinned immutable version snapshots.
- CP08: a Blob URL anchor was not a supported Android external HTTPS download.
  `resource-export.mjs` now waits for matching native saved/cancelled/failed ACK;
  `LiveBridge` + `HomerActivity` use `ACTION_CREATE_DOCUMENT`. Active exact-origin
  resource editor, document token, account owner, MIME, filename and 8 MiB UTF-8
  limits are checked. Role/chat documents cannot write files. Actual stream close
  precedes saved ACK; cancel and failure never claim success.
- CP11: refreshed-state failures were swallowed before success feedback; an older
  parallel credits/rewards read could replace a newer farm transaction; daily
  reward could be added twice. Client now verifies committed final state, fences
  older reads, uses authoritative transaction balance last, does not double-add
  rewards, and persists/reuses the same idempotency key after uncertain failures.
  An incompatible old service is clearly disabled, not presented as a harvest.
- CP14: only post composer drafts were persisted. Comments now save on each input
  and native hide/navigation, retain reply/media/client ID, isolate owner/post/
  live-vs-debug environment, restore before exposing the new comment editor,
  and clear only after confirmed send. Async owner changes cannot restore a
  prior account's draft.

## Verification run

1. `node --test tools/tests/resource-flow-repair.test.mjs tools/tests/mobile-r25-resources.test.mjs`
   — 11 passed, 0 failed.
2. `C:/Users/ROG/AppData/Local/Programs/Python/Python313/python.exe tools/tests/resource_flow_server_test.py`
   — 4 real SQLite in-memory contracts passed. Original-source bug reproduced;
   patched source passes cancel/confirm/search, permissions, hidden deleted
   detail/versions, blocked revival/favorite, immutable snapshot preservation.
3. `C:/Users/ROG/AppData/Local/Programs/Python/Python313/python.exe tools/tests/resource_flow_browser_checks.py`
   — shipping page/scripts at 390×844 and 1440×900 passed. Actual exported JSON
   file was read and accepted by the real importer. Harvest final state, stale
   ancillary reads, deliberate 503 and same-key manual retry passed. Comment
   draft leave/other post/return/reload/failed submit/successful clear passed.
   No script errors or unexpected HTTP errors; deliberate 503 fixtures retained
   visible failure state. Evidence: `output/resource-flow-20261011/browser-results.json`.
4. `android-app/gradlew.bat testDebugUnitTest --tests org.nebula.horizon.composeai.ctf.ResourceExportPolicyTest`
   — BUILD SUCCESSFUL. Native main Java compiled, resource origin/filename/MIME/
   size policy tests passed.
5. Web modified-file `git diff --check` passed.

## Explicitly not established

### Final host follow-up

- After the mounted JSON transport compatibility fix, the ordinary debug APK
  was rebuilt and its exact packaged assets checked again. The same five-class
  native gate passes 14/14 in 23.604s; compose/color/presentation tests use this
  rebuilt APK. See `output/repair-20261011/*after-native-mount-r366.log` and the
  repair report for the current SHA-256. An additional real Activity flow under
  a separate loopback-only `.coldqa` identity passes with 1101-message histories
  and one retained engine, but first-history ~3.6s/warm ~1.4–1.8s/memory ~1.5–1.7s
  do not pass instant-entry acceptance. No live server/account/provider proof.

- Another saved-export ACK failure is retained in
  `output/repair-20261011/native-final-ui-r366.log`. Isolated export,
  memory+export, and the original combination then passed without reproducing it.
  The exact cause of that occurrence is not established. Source did confirm a
  real risk: page-finished cancelled all callbacks on the operation Handler.
  Readiness now has a separate Handler; queued operation completion survives its
  cancellation in a deterministic native test. No owner/document guards removed.
- Final installed APK suite (history, database, actual memory, export, camera
  boundary) is **14/14, 24.385 seconds for the whole suite**, recorded in
  `output/repair-20261011/native-delivery-final-r366.log`. This is isolated QA,
  not formal cold-start evidence or a live service deployment.
- An explicit image-capture input now launches the camera with a private full
  photo output instead of the gallery picker. Its distinct CameraFileProvider is
  limited to camera-captures cache. Tests traverse the actual Chrome client to
  camera Intent, consume full file bytes, cancel, refuse permissions and reject
  a late document. The sensor boundary is synthetic. Retain source/provider and
  fixture failures, not just the final pass; no real user photos are used.
- Community post drafts are readable/editable locally before permission replies;
  live publish/media/preflight still require current authority. Server ACK alone
  clears a published draft. Media reads/uploads have owner/epoch/environment and
  draft/post fences; publishing freezes removal controls. An actual PNG-input
  browser test exposed reactive proxy ticket identity, now fixed with a scalar
  operation ID. Browser source and final APK compiled assets pass four complete
  light/dark phone/desktop journeys. No formal posts/media were uploaded.

- Parent's first APK 366 `ResourceExportDeviceTest` run failed to obtain the
  cancellation ACK. Root cause found in the fixture: an action-only ActivityMonitor
  filter does not match SAF's `CATEGORY_OPENABLE` and `application/json`, so it
  launches a real picker instead of returning the intended synthetic cancellation.
  The filter now includes both, asserts platform `IntentFilter.match` on the real
  SAF intent, and requires exactly one picker hit before the unchanged ACK assertion.
  Node tests including this fixture source contract pass 7/7. This agent did not
  operate shared ADB/Gradle or claim the corrected device test has passed.
  Parent subsequently rebuilt and passed the final APK's 11-test combined
  native suite (history, database, actual memory and export):
  `output/repair-20261011/native-final-isolated-r366.log`, 75.022 seconds
  for the whole suite, not export latency. Its MediaStore file is synthetic and
  cleanup targets only that exact test-owned URI.
- Browser fixtures use synthetic data, not production or user account data.
- `server-patches/resource-flow-20261011/backend.patch` and manifest are generated
  but **not deployed**. Server owner must compare current source baseline and
  apply/deploy the reviewed incremental patch.
- Read-only formal farm verification was stopped before any request: the local
  credentials file's email did not match the authorized expected test account.
  No login attempts, credentials or user values were output. Live service's
  unified farm contract and production harvest remain unverified.
- Local current backend farm code has atomic unified-points and idempotent
  harvest, but this does not prove the deployed service has that implementation.
  If formal `farm/state` lacks `account_balance` or `profile.points==coins`, the
  server needs its proper unified-points implementation; never fabricate credits
  in the client.
