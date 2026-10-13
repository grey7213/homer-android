# R366 private conversation memory: local-first backup contract

Status: local implementation and isolated verification only. **No server deployment, commit, push or release.**

## Execution and acceptance

Keep each private memory bound to exactly `[owner, app, conversation]`. Commit its complete bytes to the existing extension-settings outbox before the local world mirror. Continue working offline; asynchronously reuse the existing authenticated runtime-state GET/POST for backup. Restore only a verified cloud envelope into a namespace absent on the phone, never overwrite an explicit local empty book. Old clients omitting the namespace must not erase it. Preserve author worldbooks/global plugin settings and all unrelated work.

Implementation:

- `variables.homer_memory_book`: version-1 envelope, exact tuple, UTF-8 body, SHA-256 digest, unique change ID; opaque server version lives in outbox metadata.
- Real strict outbox transaction is the memory save acknowledgement. The world record is a projection repaired from that durable snapshot before management or real scanner injection.
- Real private world edit/delete writes are intercepted before their projection. Retired fetch wrappers pass through; unrelated streamed requests retain their original body semantics.
- A staged already-loaded runtime-state response restores only after genuine current chat metadata matches. An old generic settings row lacking this namespace does not hide the verified remote memory. No new network wait on opening the memory page.
- Phone data wins. Delayed ACKs cannot clear newer edits. CAS conflict obtains one authenticated latest version and tries the unchanged phone snapshot once; another race remains pending. Storage replay never replays generation/billing.
- Complete proof checks scope, digest/change ID and server version. A legacy HTTP-200 response is not a backup ACK. UI distinguishes local save from confirmed cloud backup.
- Variables retain the existing 512,000-byte limit, including the persisted server version. Oversized edits reject as a whole, without truncating or replacing previous memory.
- Independently deployable `server-patches/memory-cloud-r366/` preserves the optional namespace for old-client writes, rejects scope/hash/CAS violations, and retains ten prior snapshots in one SQLite transaction. Existing authenticated endpoints remain unchanged.

## Commands and evidence

All data below are isolated synthetic data, not live users/models/databases.

```powershell
$memoryTests = Get-ChildItem -LiteralPath tools/tests -Filter 'memory-*.test.mjs' | ForEach-Object FullName
node --test $memoryTests
node --test tools/tests/memory-conversation-runtime.test.mjs tools/tests/memory-cloud-outbox.test.mjs tools/tests/memory-cloud-bridge.test.mjs tools/tests/mobile-r35-outbox.test.mjs tools/tests/chatarchive-outbox-batch.test.mjs tools/tests/mobile-r40-outbox-noop.test.mjs
& 'C:/Users/ROG/AppData/Local/Programs/Python/Python313/python.exe' tools/tests/test_memory_cloud_r366.py
& 'C:/Users/ROG/AppData/Local/Programs/Python/Python313/python.exe' tools/tests/memory_cloud_browser_checks.py
```

- Memory Node group: 49/49 passed, including exact source-map parity.
- Related outbox group: 66/66 passed. Groups overlap; counts are not additive.
- Real SQLite + extracted unchanged maintained provider storage methods: 8/8 passed, including legacy omission, explicit empty, scope isolation, stale CAS, complete repeat, oversize rejection and failed-write rollback.
- Headless real runtime at 390×844 and 1440×900: genuine extension range→single synthetic provider→preview/no autosave→save→edit/disable/re-enable→actual scanner/prompt injection→A/B/A; entirely fresh browser storage restored via actual SQLite contract and unchanged selected product bridge restore function, then injected the restored memory and isolated B. Page, HTTP, request and console failures all empty. Auth/launch peripherals are synthetic; the full authenticated production host is not claimed tested by this fixture.
- Incremental patch `git apply --check` passed against an isolated exact source copy. Maintained provider input SHA-256: `4AEA1DAD268FAEE0B28610BFEC12FDFAAF24BE68893A8C3D662F1EC0286ADA8B`.
- Evidence: ignored `output/memory-private-20261011/cloud-restore-browser-checks.json` and `cloud-recovered-{390,1440}.png`.

Real build: official fixed Bun 1.3.1 binary, running the upstream `build.ts`, no alternate bundler or remote installer script. ZIP SHA-256 matches the official GitHub asset digest: `F6619E31752E1259C1D2090EC3EA16366FA5A8EB49B78ED187CD05930C38BE55`. Binary SHA-256: `CDFA63183662D452A8E58276AAAC71597AB491BF83975FFCEDF3C5BAFA8E3171`.

Final Memory Books bundle SHA-256: `FC53B4E51ED56A33A8C210F2567F1C390C0153699CDAED911D1427EB3A56FC33`.

Final source map SHA-256: `A53E2526255093C51393AE591CCE51D92E2B4852A775879E338C0C63AB78F708`.

Final `memory-ui.js` SHA-256: `CD2030E1CC0A2B1968B68B863AF754BB1D5B9117FF454BC34ECD364C1F063425`.

## Remaining gates and limitations

1. The new helper and incremental provider patch are **not deployed**. APK/source merge does not enable cloud restore on its own; production recovery is not yet verified. Unuploaded phone-private data cannot survive uninstall.
2. The subagent did not use ADB/Gradle/devices. Main-thread final APK asset identity and native journey remain separate acceptance gates; these browser timings are not Android cold-start promises.
3. No author book or unscoped old book is guessed/migrated into a private conversation. No real user storage or credentials were used.
4. Shipping/export inputs must include the new external module `sillytavern-runtime/public/scripts/homer-memory-sync.mjs`, the modified outbox/bridge/UI, and the real Memory Books bundle/map/source chain. The backend helper requires its own reviewed deployment.
