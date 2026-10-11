# Homer Android working notes

- Current release: 1.18.1 / 354 (2026-10-07), commit `465e2a9`. Added user-local-backup page/entry and authenticated native ZIP download; production backup routes/web and signed APK are live. Pixel 6 verified 353→354 upgrade, login/history retention, latest-version source and 6,025-byte ZIP download from production. See `specs/user-local-backup-20261007.md`; PR #19 review evidence remains at `specs/pr19-review-20261007.md`.

- Native source of truth: this repository's `android-app/`. Web source of truth: `E:\酒馆开发` (`grey7213/AIXingYue`). Never overwrite either tree with a contributor's full copy; apply and inspect patches against their pinned baseline.
- Read `MAINTAINER.md`, `CONTRIBUTING.md`, and the relevant `specs/` before changing release behavior.
- Windows builds require an ASCII path, JDK 17+, SDK 35+, Node 20+. Use Android Studio JBR and `E:\Android\Sdk`.
- Assemble the pinned web tree with `python tools/bootstrap.py`; apply pending patches with `python tools/apply_web_patches.py --strict`. For production build inputs, use verified main-workspace web files.
- Verify with Gradle `testDebugUnitTest lintDebug assembleDebug`, device tests when available, and `python tools/verify_apk_assets.py`. UI changes require rendered/device checks.
- Preserve package `org.nebula.horizon.composeai` and the established Homer release certificate. 275 and later upgrade in place, and `tools/publish_homer_apk.py` refuses to publish a package change that the published `release.json` canonical cannot upgrade into. APKs, credentials, keystores and temporary evidence never enter Git. Evidence belongs under ignored `output/`.
- Known open item (R28): Wind ships the same `org.nebula.horizon.composeai` under a different certificate, so both cannot install on one device. Renaming to an independent id is not a drop-in fix — it cuts in-app upgrades for every existing install and the publisher rejects it. A real migration needs a separate website download entry, a user-facing announcement, and a deliberate change to the publisher's package gate, together. Never uninstall the old package or pretend a different applicationId can read its private data. See `docs/mobile-r28-analysis.md`.
- Main is protected; review PR code and its `build` result before merging. Push verified source commits and release APKs through `grey7213/homer-android-apk` Releases plus the existing website publisher.
- Java bridge calls must retain the injected receiver: `window.HomerNative.method(...)`.
- `PatchManager` data patches override bundled web assets; an APK release must account for old slots as well as update the published data patch when needed.
- Current task map: `specs/in-app-update-20260905/`.
- Latest PR review/release work: `specs/pr7-release-20260908/`. Community preview requires `/admin/api/me`; the new social backend was not included and its moderation entry remains disabled.
- PR #8 (`7ddba11`) deliberately dropped the community web patch, which also deleted group chat. Cold start restores the last trusted `/app/` page and falls back to `/app/explore.html`; do not point the default home at a page whose backend is not deployed. The community server side still has no `social_*` tables in production.

## Verified pitfalls

- R366 integrated source delivery (2026-10-11): ignored web files and generated
  extension source maps are not included merely because a native commit exists.
  Export the incremental patch after all accepted earlier patches; explicitly
  include the real bundle's map, normalize map path separators, and verify its
  own sourcesContent without requiring build-only node_modules. Reconstruct all
  patches on a separate pinned tree and compare Git trees/content (Windows
  checkout line endings may differ). Run tests/build from the reconstructed
  scope; keep service contract fixtures portable and code-only. Closing a PR
  is not a main revert or deployment, and a green source PR is not production
  backend verification or instant-entry acceptance.

- R366 mounted request transport (2026-10-11): construct ordinary string-backed
  JSON requests at their final dialogue-mounted URL before creating Request.
  Rebuilding a Request at a second URL from its `.body` can turn that JSON into
  a Chromium streaming upload and fail on HTTP/1.1 before startup completes.
  Preserve true caller-owned streams, signals, headers, and account epochs;
  do not buffer genuine streams or retry generation/writes. Classify mounted
  paths canonically for local storage too. Verify the ordinary Activity with
  its real handlers/client and isolated account, not only a replaced WebView.
  The R366 cold QA flow works but first-history 3.6s and warm 1.4–1.8s are not
  instant-entry acceptance or production-account/provider evidence.

- R366 asynchronous UI completion (2026-10-11): navigation readiness cancellation
  must not clear file-write completion callbacks; use separate main-loop handlers.
  Keep intermittent missing-ACK failures and distinguish a confirmed source risk
  from an unproven causal explanation. Do not widen timeouts or replace origin/
  document/account guards to pass a fixture. A camera capture input must dispatch
  ACTION_IMAGE_CAPTURE with a full-size private output, not the gallery intent.
  Give a separate camera FileProvider its own component class as well as authority:
  two registrations of the same class can share the wrong Android binder.
  Test actual input-to-intent, output bytes, cancel, permission refusal and stale
  documents; synthetic camera output is not real sensor/OEM acceptance.

- R366 local draft / reactive media (2026-10-11): phone-private draft reading and
  editing may precede online publishing authority, but upload/preflight/publish
  remain gated and publishing rechecks sanctions. Preserve draft/client identity
  until an explicit post ACK. Fence asynchronous media by owner/epoch/mode and
  exact draft or comment identity, and clear only the operation's busy lock.
  Alpine wraps assigned objects in proxies: plain-object operation-ticket identity
  passes VM tests but fails actual browser upload completion. Use scalar operation
  IDs and verify the real file input → read → API → draft → failed/successful post
  journey. Inspect computed contrast after all imported CSS; a theme variable or
  earlier override existing in source does not prove the final dark UI uses it.

- R366 phone settings authority (2026-10-11): deduplicate the exact captured
  persisted body, not extension settings alone. Conversation variables and
  scoped metadata must change the signature too; adopt that captured signature
  after the transaction, never a later scope's live state. A complete durable
  phone-state row must restore without its optional resource mirror; legacy
  incomplete rows still require the normal reconciliation path. Verify offline
  new-document restore and account/scope changes during commit. Keep isolated
  WebView journeys separate from ordinary Activity boot: a competing host can
  invalidate fixture timing, and isolated success is not formal cold-start proof.

- R366 shared storage boundary (2026-10-11): passing source-browser tests and
  APK byte hashes do not prove the packaged dependency graph is usable. The
  outer histories page imports outbox -> memory sync -> digest; wrapping the
  digest in an eager runtime-core facade boots dialogue globals there and
  crashes with `jQuery is not defined`. Keep shared storage modules outside
  the eager dialogue core, verify the manifest boundary, and exercise the
  final APK's actual outer history page with no dialogue globals. Do not add
  fake jQuery or remove that native test to hide the regression.

- R365 history deletion (2026-10-10): a 100-cycle read/navigation audit that
  excludes destructive writes is not deletion coverage. Exercise confirmation
  cancel, multi-select, large stored histories, offline removal, stale server
  lists, restart, delayed saves/ACKs and account changes in isolated fixtures.
  Commit owner-scoped canonical deletion markers atomically before UI removal;
  delete only explicitly selected IDs. Keep permanent fences in chat/session/
  native stores and replay only idempotent cloud deletion, never generation or
  billing. Cloud failures remain visibly pending/blocked and must not resurrect
  local records. Verify final APK native taps and cleanup, not browser results
  alone; do not delete existing user histories for QA.

- R364 memory lifecycle (2026-10-10): the existence of `HomerMemoryBooks.open`
  does not prove a bound, interactive conversation. Verify the active owner,
  conversation metadata, real message count and painted home in the final APK.
  Reuse one real view within the active scope; fence scope/metadata identity and
  cancel late work. Background preparation must not select markers, save settings
  or generate. Reopening a retained Popup needs real Back/cancel and refresh tests
  so listener-bearing controls are not lost or duplicated.
- R364 startup dependencies: preserve streamed Request semantics when rewriting
  mounted URLs, carry the ACK stamp/version on local archive reads, and do not
  treat same-owner profile refresh as account switching. Keep genuine logout and
  owner-epoch guards. Run native repeat-open and A/B/A tests, including a long
  archive; browser fixture success cannot replace final packaged WebView checks.

- R363 source authorization (2026-10-09): the user accepted the restored full-site embedded workshop and requested submission. Update existing PR #22 with the exact eight native build inputs used by the verified immutable R363 APK, plus handoff notes; exclude unrelated worktree changes. Safe areas, visible error/retry and same-origin explicit verified downloads remain required. Normal site authorization and separate server rollout are not replaced by a source PR. No merge, website/server deployment or official APK publication is authorized by this request.

- Latest explicit acceptance (2026-10-09): R360 landscape gameplay was accepted. The user now requests exploration's notification-adjacent entry, UI polish, explicit on-demand ChatArchive workshop downloads and account game/branch restore, then a source PR. This supersedes the earlier no-commit acceptance phase, but does not authorize a formal APK/server release. Preserve the clearly labelled equivalent reconstruction and director-free ordinary gameplay; never claim missing protected 1.2.6 Hot gameplay was recovered. Stopped integrations and private QA media/accounts are not release inputs.

- R361 delivery: native login/download browser has no Homer bridge and carries only the workshop's own cookie. Exact revision/hash binds media to games. CAPK/ZIP import and native Spine rendering are verified; 7Z/RAR are not supported. Cloud game backups require separate deployment of `server-patches/archive-r361/`, not just this PR/APK. Unuploaded phone-private data cannot survive uninstall. Do not claim production restore or live providers from synthetic HTTP/SQLite tests. Reconstruct the full ordered web patch chain on a clean pin and verify packaged assets before handoff.

- R355 rejection: a stage skin over existing chat history is not an AI visual-novel game. New gameplay must have its own durable game/person/channel/event state, start without old histories, create exactly one authorized dedicated conversation per person, and complete new game → private thread → date → stage → remembered event → reopen → branch restore. Count full-loop acceptance, not visible widgets or unrelated passing tests. Protect pending generation before network work; do not auto-replay uncertain generation/billing. Mark synthetic-provider/browser checks separately from actual provider/Android evidence. Never call independent reconstruction recovered original source.

- Game provider guard: the shipping EventEmitter deliberately catches listener exceptions. A throwing prompt listener does not block sending or billing. Capture a turn-scoped guard in the actual sender before any await, enforce it directly after final settings listeners and before fetch, and preserve its rejection even if the higher-level Generate catches sender errors. Test with the shipping event implementation; do not use a throwing fixture emitter as proof of fail-closed behavior. Test ordinary requests as well as stopped/stale/ABA and unsupported preset requests.

- Local backup: WebView's existing DownloadListener ignores Blob URLs and external-browser downloads do not inherit the app Cookie. Use the fixed same-origin `/console/api/web/user-backup/download` through `HomerNative.downloadUserBackup()` on the active backup page, with DownloadManager and the current Cookie. Use a timestamped filename as the download title so DocumentsUI can distinguish backups. Pixel 6 API 33 verified actual ZIP save, system picker selection and import; see `specs/user-local-backup-20261007.md`.

- R354: phone-owned canonical chat archives are durable data, not an ACK-evicted
  cache. Read prepared histories locally before cloud authorization; save locally
  before live/opportunistic uploads. Never replay generation or billing requests.
  Test actual full runtime offline, not only storage helpers: standalone welcome
  templates can append late into an embedded history. Async mutation recovery must
  fence owner, scope and epoch, including shared chat-array reuse across accounts.
  Protected client saves require the incremental Python provider deployment first;
  a PR/APK merge alone is not a server deployment or pre-loss data recovery.

- PR #19: asset enumeration cannot detect a module deleted from both source and APK. `card-experience-runtime.mjs` still imports Spine, so retain `spine-portrait.mjs`, `spine-webgl.js` and its license; `verify_apk_assets.py` checks these independently. On Windows, source-map content comparisons normalize only CRLF/LF and VM fixtures accept `\r?\n`; do not remove the content or mapping checks. R353 has five cumulative segments followed by the maintainer registration patch.

- R353 delivery: export every accepted cumulative module and real source map, apply the complete partitioned patch set on a clean pinned tree, then rebuild and hash-check the APK. Preserve upstream workshop account isolation. Never decode a Git diff using universal-newline conversion: authored CRLF can be lost even though full-index IDs are retained. Verify platform-stable TS/map parity and non-target bundle bytes; fixture seams must tolerate new module imports without weakening product assertions.

- R32: test failed generation against actual balance components and fee events, including HTTP-200 error bodies, partial streams and final write failure. A disabled-looking send button alone is insufficient: gate click/Enter and programmatic generation, distinguish auth/balance errors, and verify failure → reopen → switch model → successful generation. Binding an existing local chat mirror must preserve its original integrity header; never generate a new identity on every reopen or bypass the integrity check to hide the conflict. Client tests do not replace deploying the Python billing changes.

- User execution preference: after a cause is confirmed and an in-scope fix is actionable, implement and verify in the same work session. Do not end with another explanation of the same cause or promise to start. Keep updates short. Persist unfinished acceptance gates across handoffs; do not submit or hand off an APK as fixed while a gate still fails.

- R31: failed cold-entry acceptance blocks APK handoff even if warmed entry and generation pass. Measure click-to-painted as well as internal ready, using fresh browser contexts without waiting for prewarm; report sample count and do not call a browser proxy an Android device test. Never publish an intermediate optimization as a completed fix. Lazy-loaded editors must pass real open/edit/save/reopen tests, not just asset existence or successful startup.

- R30: new conversation entry points must reuse an initialized engine rather than add a nonce iframe. Functional chat tests do not measure startup: record cold initialization, actual click-to-ready, tab revisit and role switch separately. A hidden loading overlay is not a speed fix. Preview-only optimizations must not disable ordinary-chat persistence, permission checks, card scripts or per-generation preset refresh.

- R29: never treat a preset-debug launcher as the requested full admin conversation workspace. Verify edits through the actual right drawer and final provider payload; preview drafts require both signed preview claims and current administrator status. Do not write previews to normal histories. APK-only releases cannot deploy new Python/Node routes.
- R29: never await a shared debounce timer inside the generation recovery chain if the next generation clears that timer. That leaves an unresolved Promise and wedges subsequent recovery. Keep the chain settleable; test failure → rollback → new generation. Quiet extension generations must not overwrite chat-reply diagnostics.

- Acceptance regression gate: a visible local chat snapshot is not a ready conversation. Test native process restart as well as webpage navigation, and time the actual Memory Books home against real messages. If full startup still stalls, do not label the package "instant" or hide the wait as a fix. Preserve separate cold-start and ready-menu measurements.
- Resource updates: mutable JS/CSS/JSON URLs are not immutable content hashes. Revalidate bundled text locally; invalidate HTTP resource cache on APK replacement without clearing login cookies, WebStorage or conversation databases. Test an upgrade with existing login and history, not only a clean installation.

- Symptom: Android Back leaves a page instead of cancelling its new HTML dialog. Cause: WebView Activity history handling does not invoke the web overlay handler. Fix: Ask the active document and its fixed same-origin dialogue iframe to cancel the top overlay first; honor the DOM cancel event. Verify: API 33 confirmation cancellation, multiple-choice discard, a prevented cancellation, and nested dialogue modal all passed without navigation.

- Symptom: An APK upgrade can still load an older activated data patch. Cause: Patch slots outrank bundled assets. Fix: Clear only activation metadata when the bundled APK version changes; require a patch's `min_app_version` to match that version. Verify: `PatchUpgradeTest` on API 33 preserves a separate account sentinel and keeps a current-version slot on ordinary restart.
- Symptom: Shell `uiautomator dump` appears to show a stale update dialog during downloads. Cause: Frequent progress accessibility events prevent its idle wait from completing, leaving the previous XML on disk. Fix: Remove the previous task-owned dump before capture; exercise progress cancellation with Android Back after observing an actual download and screenshot. Verify: Ten emulator update scenarios passed, including cancellation and removal of the partial file.
