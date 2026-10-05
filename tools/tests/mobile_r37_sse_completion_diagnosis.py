"""Opt-in completion diagnosis around an unchanged R34 browser/native runner.

This is not an acceptance override or a performance benchmark. Only the actual
OpenAI parsed-SSE reader is observed; its promises/results/arguments are retained.
No response/request body, chunk text, headers, query, account or token is saved.
The original R34 report, network-failure classification and exit code are kept.
Example (run serially with the already-authorized local synthetic fixture):
  python tools/tests/mobile_r37_sse_completion_diagnosis.py \
    --enable-sse-completion-diagnostics --diagnostic-output output/.../sse.json \
    --credentials output/.../credentials.json --output output/.../r34 --width 390

Use --runner native to observe the original mobile_r34_android.py CDP runner;
no new context/page, viewport override, request route or fetch hook is used.
Plan: install bounded reversible test-only observers in actual contexts; execute
the real runner; retain timestamp correlations without claiming causation.
Risk: diagnostic observers add CPU work, so their times are not latency evidence.
Parsed-reader EOF is not a measurement of the provider's wire EOF.
Reader wall_ms is the runtime document's Date.now; request callback wall_ms is
Python host time.time after driver dispatch. Those clock domains are not
calibrated. v1's empty association arrays do not prove absence of a matching
request. v2 preserves callback timestamps, snapshots public Request.timing,
and reports reader/request association as null/unavailable until a genuine
same-browser-clock verification exists. No offset or sequence join is used.
The original native runner's os._exit watchdog is not intercepted: a hard exit
can bypass Python finally and current-document cleanup. Preserve that hang;
never use this diagnostic to reinterpret it as a completed acceptance run.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import runpy
import sys
import time
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
RUNNER = Path(__file__).with_name('mobile_r34_chat_e2e.py')
NATIVE_RUNNER = Path(__file__).with_name('mobile_r34_android.py')
GENERATION_PATH = '/module/dialogue/api/backends/chat-completions/generate'
SSE_PROBE = r"""(() => {
  if (!location.pathname.startsWith('/module/dialogue/')) return;
  if (window.__r37SseCompletionDiagnosis) return;
  const sink = window.__r37SseCompletionRecord;
  if (typeof sink !== 'function') return;
  let active = true, emitted = 0, nextReader = 0, saturated = false;
  const documentId = 1 + Math.floor(Math.random() * 9007199254740990);
  const readers = new WeakMap(), restorers = [];
  const wall = () => Math.trunc(Date.now());
  const emit = (kind, state = null, extra = {}) => {
    try {
      const pending = sink({kind, wall_ms: wall(), document_id: documentId, reader_id: state?.id || 0,
        done_seen: !!state?.done, eof_seen: !!state?.eof,
        done_wall_ms: state?.doneAt ?? null, eof_wall_ms: state?.eofAt ?? null, ...extra});
      if (pending && typeof pending.catch === 'function') void pending.catch(() => {});
    } catch {}
  };
  const record = (kind, state = null, extra = {}) => {
    if (!active) return;
    if (emitted >= 2000) {
      if (!saturated) { saturated = true; emit('probe_limit_reached'); }
      return;
    }
    emitted++; emit(kind, state, extra);
  };
  const replace = (prototype, name, wrap) => {
    const before = Object.getOwnPropertyDescriptor(prototype, name);
    if (!before || typeof before.value !== 'function') throw new TypeError();
    const replacement = wrap(before.value);
    Object.defineProperty(prototype, name, {...before, value: replacement});
    restorers.push(() => {
      if (Object.getOwnPropertyDescriptor(prototype, name)?.value === replacement)
        Object.defineProperty(prototype, name, before);
    });
  };
  const generationStatus = event => {
    try {
      const status = event?.detail?.status;
      if (['complete', 'failed', 'cancelled'].includes(status)) record('generation_status', null, {status});
    } catch {}
  };
  const cleanup = () => {
    active = false;
    removeEventListener('homer-generation-diagnostic', generationStatus);
    for (const restore of restorers.reverse()) { try { restore(); } catch {} }
    delete window.__r37SseCompletionDiagnosis;
    return {restored: true};
  };
  try {
    replace(ReadableStream.prototype, 'getReader', original => function(...args) {
      const reader = Reflect.apply(original, this, args);
      try {
        // There is one getReader call in actual scripts/openai.js. The stack is
        // used only as a boolean selector; no stack/URL/query is retained.
        if (/(?:\/|\\)scripts(?:\/|\\)openai\.js(?:\?[^:\s)]*)?:\d+:\d+/.test(String(new Error().stack || ''))) {
          const state = {id: ++nextReader, done: false, eof: false, doneAt: null, eofAt: null};
          readers.set(reader, state); record('reader_created', state);
        }
      } catch {}
      return reader;
    });
    replace(ReadableStreamDefaultReader.prototype, 'read', original => function(...args) {
      const state = readers.get(this);
      const promise = Reflect.apply(original, this, args);
      if (state) {
        record('read_called', state);
        // Attach a side observer but return exactly the original promise. No
        // extra awaited chain, changed result, or content-bearing event exists.
        void promise.then(result => {
          try {
            if (!active) return;
            if (result?.done === true) {
              state.eof = true; state.eofAt ??= wall(); record('reader_eof', state);
            } else if (result?.value?.data === '[DONE]') {
              state.done = true; state.doneAt ??= wall(); record('done_marker', state);
            }
          } catch {}
        }, () => record('read_rejected', state)).catch(() => {});
      }
      return promise;
    });
    replace(ReadableStreamDefaultReader.prototype, 'cancel', original => function(...args) {
      const state = readers.get(this);
      if (state) record('cancel_called', state);
      const promise = Reflect.apply(original, this, args);
      if (state) void promise.then(() => record('cancel_resolved', state),
        () => record('cancel_rejected', state)).catch(() => {});
      return promise;
    });
    replace(ReadableStreamDefaultReader.prototype, 'releaseLock', original => function(...args) {
      const state = readers.get(this);
      if (state) record('release_lock_called', state);
      return Reflect.apply(original, this, args);
    });
    addEventListener('homer-generation-diagnostic', generationStatus);
    window.__r37SseCompletionDiagnosis = {installed: true, cleanup};
    record('probe_installed');
  } catch {
    record('probe_install_failed'); cleanup();
  }
})()"""

# Playwright has no remove_init_script API. Native CDP detaches without closing
# the WebView, so this reload bootstrap asks a read-only binding before patching
# any prototype. Cleanup closes that gate; retained registrations are then
# inert even if the same actual document reloads after the diagnostic run. The
# handshake is asynchronous: probe_installed/reader_created are coverage, and
# an unobserved reader is never evidence that DONE/cancel did not occur.
NATIVE_INIT_PROBE = r"""(() => {
  if (!location.pathname.startsWith('/module/dialogue/')) return;
  if (window.__r37SseCompletionNativeClosed) return;
  const sink = window.__r37SseCompletionRecord;
  if (typeof sink !== 'function') return;
  try {
    Promise.resolve(sink({kind: 'probe_active_check'})).then(active => {
      if (active !== true || window.__r37SseCompletionNativeClosed) return;
      """ + SSE_PROBE + r"""
    }).catch(() => {});
  } catch {}
})()"""

NATIVE_CLEANUP_PROBE = r"""(() => {
  window.__r37SseCompletionNativeClosed = true;
  return window.__r37SseCompletionDiagnosis?.cleanup?.() || {not_installed:true};
})()"""

KINDS = frozenset(('reader_created', 'read_called', 'reader_eof', 'done_marker',
                  'read_rejected', 'cancel_called', 'cancel_resolved', 'cancel_rejected',
                  'release_lock_called', 'generation_status', 'probe_installed', 'probe_install_failed', 'probe_limit_reached'))


def safe_probe_record(payload):
    """Whitelist independently of the injected JS; never retain unknown fields."""
    if not isinstance(payload, dict) or payload.get('kind') not in KINDS:
        return None
    result = {'kind': payload['kind']}
    for key in ('wall_ms', 'document_id', 'reader_id', 'done_wall_ms', 'eof_wall_ms'):
        value = payload.get(key)
        if key in ('done_wall_ms', 'eof_wall_ms') and value is None:
            result[key] = None
        elif isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 10 ** 16:
            result[key] = value
        else:
            return None
    for key in ('done_seen', 'eof_seen'):
        if not isinstance(payload.get(key), bool):
            return None
        result[key] = payload[key]
    if payload['kind'] == 'generation_status':
        if payload.get('status') not in ('complete', 'failed', 'cancelled'):
            return None
        result['status'] = payload['status']
    return result


def wall_ms():
    return int(time.time() * 1000)


def hashes():
    return {relative: hashlib.sha256((ROOT / '.web-cache/tree' / relative).read_bytes()).hexdigest().upper()
            for relative in ('frontend/app/assets/js/chat.js', 'sillytavern-runtime/public/script.js',
                             'sillytavern-runtime/public/scripts/extensions/homer-bridge/index.js',
                             'sillytavern-runtime/public/scripts/openai.js')}


def safe_request_timing(request, phase):
    """Copy only public API timing numbers; never store its mutable dict.

    Primary: Playwright _impl/_network.py Request initializes startTime=0 and
    other values=-1; Response updates the cached timing and requestfinished or
    requestfailed sets responseEnd. The Chromium driver derives startTime from
    CDP wallTime (epoch ms); responseStart/responseEnd are relative ms, not
    Python callback timestamps. Availability is not clock calibration.
    """
    result = {'phase': phase, 'clock_basis': 'browser_network_start_epoch_ms_and_relative_offsets'}
    try:
        timing = request.timing
    except Exception:
        timing = None
    for key in ('startTime', 'responseStart', 'responseEnd'):
        value = timing.get(key) if isinstance(timing, dict) else None
        minimum = 0 if key == 'startTime' else -1
        result[key] = value if isinstance(value, (int, float)) and not isinstance(value, bool) \
            and minimum <= value < 10 ** 16 and math.isfinite(value) else None
    result['start_time_available'] = result['startTime'] is not None and result['startTime'] > 0
    result['response_start_available'] = result['start_time_available'] \
        and result['responseStart'] is not None and result['responseStart'] >= 0
    result['response_end_available'] = result['start_time_available'] \
        and result['responseEnd'] is not None and result['responseEnd'] >= 0
    return result


def correlations(context):
    rows = []
    for created in context['reader_events']:
        if created['kind'] != 'reader_created':
            continue
        events = [event for event in context['reader_events'] if event['frame'] == created['frame']
                  and event['document_id'] == created['document_id']
                  and event['reader_id'] == created['reader_id']]
        cancels = [event for event in events if event['kind'] == 'cancel_called']
        rows.append({'frame': created['frame'], 'document_id': created['document_id'], 'reader_id': created['reader_id'],
                     # No actual same-browser-clock verification currently
                     # exists. Do not convert unknown into an empty match set,
                     # or join by callback order/handwritten offset/boolean.
                     'same_frame_overlapping_request_sequences': None,
                     'request_correlation_available': False,
                     'request_correlation_unavailable_reason': 'unverified_browser_clock_basis',
                     'python_callback_clock_used_for_correlation': False,
                     'done_seen': any(event['kind'] == 'done_marker' for event in events),
                     'parsed_reader_eof_seen': any(event['kind'] == 'reader_eof' for event in events),
                     'cancel_calls': [{key: event[key] for key in ('wall_ms', 'done_seen', 'eof_seen',
                                                                  'done_wall_ms', 'eof_wall_ms')} for event in cancels],
                     'causation_proven': False,
                     'request_identity_proven': False})
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--enable-sse-completion-diagnostics', action='store_true', required=True)
    parser.add_argument('--diagnostic-output', type=Path, required=True)
    parser.add_argument('--runner', choices=('browser', 'native'), default='browser')
    args, original_args = parser.parse_known_args()
    if not args.enable_sse_completion_diagnostics:
        parser.error('The read-only completion probe requires explicit opt-in')
    if '--output' not in original_args:
        parser.error('Pass an explicit fresh --output directory to the original R34 runner')
    output_index = original_args.index('--output') + 1
    if output_index >= len(original_args) or original_args[output_index].startswith('--'):
        parser.error('The original R34 --output needs a fresh directory')
    original_output = Path(original_args[output_index])
    if original_output.exists() and (not original_output.is_dir() or any(original_output.iterdir())):
        parser.error('Never overwrite earlier R34 evidence; choose a fresh --output directory')
    if args.diagnostic_output.exists():
        parser.error('Never overwrite earlier SSE diagnosis evidence')
    args.diagnostic_output.parent.mkdir(parents=True, exist_ok=True)

    # Import only after opt-in validation. No fixture/login/provider/browser work
    # occurs on import, --help or an invocation without the diagnostic flag.
    from playwright.sync_api import Browser, BrowserContext
    runner = NATIVE_RUNNER if args.runner == 'native' else RUNNER
    # CDP detach leaves the native context alive. Own unique binding/closed
    # names prevent a later diagnostic run from reusing a stale inactive sink.
    probe_suffix = str(time.time_ns()) if args.runner == 'native' else ''
    binding_name = '__r37SseCompletionRecord' + ('_' + probe_suffix if probe_suffix else '')
    def own_probe(source):
        return source.replace('__r37SseCompletionRecord', binding_name).replace(
            '__r37SseCompletionNativeClosed', '__r37SseCompletionNativeClosed_' + probe_suffix)
    probe_source = own_probe(SSE_PROBE) if probe_suffix else SSE_PROBE
    native_init_source = own_probe(NATIVE_INIT_PROBE)
    native_cleanup_source = own_probe(NATIVE_CLEANUP_PROBE)
    report = {'schema': 'r37-sse-completion-causality-v2', 'opt_in': True,
              'runner': runner.name, 'runner_mode': args.runner,
              'product_modified': False, 'acceptance_gate_modified': False,
              'diagnostic_only_not_performance': True, 'wire_eof_proven': False,
              'unobserved_marker_is_absence_proof': False, 'producer_event_limit_per_document': 2000,
              'content_headers_tokens_recorded': False, 'contexts': [], 'diagnostic_errors': [],
              'clock_contract': {
                  'reader_event_wall_ms': 'runtime_document_Date_now_epoch_ms',
                  'request_callback_wall_ms': 'python_driver_host_time_time_epoch_ms_after_callback_dispatch',
                  'request_timing': 'browser_network_start_epoch_ms_and_relative_offsets',
                  'reader_and_network_clock_verified': False,
                  'automatic_request_reader_association': 'unavailable_clock_basis',
                  'constant_offset_or_order_join_used': False,
                  'v1_empty_associations_prove_no_matching_request': False,
              },
              'workspace_hashes_are_served_source_proof': False,
              'native_reload_install_async': args.runner == 'native',
              'native_init_registration_removed': False if args.runner == 'native' else None,
              'native_init_registration_gated_inert_after_cleanup': args.runner == 'native',
              'native_hard_exit_cleanup_not_guaranteed': args.runner == 'native',
              'workspace_hashes_before': hashes()}
    original_new_context, original_close = Browser.new_context, BrowserContext.close
    original_browser_close = Browser.close if args.runner == 'native' else None
    original_connect = browser_type = None
    if args.runner == 'native':
        from playwright.sync_api import BrowserType
        browser_type = BrowserType
        original_connect = BrowserType.connect_over_cdp
    owned = {}
    attached_browsers = {}

    def observe_context(context, viewport=None, existing=False):
        if context in owned:
            return context
        item = {'context': len(report['contexts']) + 1, 'viewport': viewport,
                'existing_native_context': existing, 'existing_runtime_frames': 0,
                'reader_events': [], 'generation_requests': [], 'cleanup': [], 'dropped_probe_records': 0,
                'dropped_probe_records_scope': 'Python consumer only; JS limit separately reported'}
        report['contexts'].append(item)
        owned[context] = item
        frames, requests = {}, {}
        observer_state = {'active': True}
        handlers = []
        item_state[context] = (observer_state, handlers)

        def frame_id(frame):
            if frame not in frames:
                frames[frame] = len(frames) + 1
            return frames[frame]

        def record(source, payload):
            if isinstance(payload, dict) and payload.get('kind') == 'probe_active_check':
                return observer_state['active']
            if not observer_state['active']:
                return
            clean = safe_probe_record(payload)
            if clean is None or len(item['reader_events']) >= 4000:
                item['dropped_probe_records'] += 1
                return
            item['reader_events'].append({'frame': frame_id(source['frame']),
                                         'clock_basis': 'runtime_document_Date_now_epoch_ms', **clean})

        def requested(request):
            if request.method != 'POST' or urlparse(request.url).path != GENERATION_PATH:
                return
            request_item = {'sequence': len(item['generation_requests']) + 1,
                            'frame': frame_id(request.frame), 'path': GENERATION_PATH,
                            'started_wall_ms': wall_ms(), 'outcome': 'pending',
                            'callback_clock_basis': 'python_driver_host_time_time_epoch_ms_after_callback_dispatch',
                            'network_timing_samples': [safe_request_timing(request, 'request')]}
            item['generation_requests'].append(request_item)
            requests[request] = request_item

        def responded(response):
            request_item = requests.get(response.request)
            if request_item is not None:
                request_item.update(response_wall_ms=wall_ms(), status=response.status)
                request_item['network_timing_samples'].append(safe_request_timing(response.request, 'response'))

        def settled(request, failed=False):
            request_item = requests.get(request)
            if request_item is not None:
                request_item.update(settled_wall_ms=wall_ms(), outcome='failed' if failed else 'finished')
                request_item['network_timing_samples'].append(safe_request_timing(request, 'failed' if failed else 'finished'))
                if failed:
                    # The original R34 report still retains its unchanged raw
                    # failure. This extra report only saves an error enum.
                    failure = request.failure or ''
                    request_item['failure_category'] = failure if re.fullmatch(r'(?:net::)?ERR_[A-Z0-9_]+', failure) else 'unclassified'

        try:
            context.expose_binding(binding_name, record)
            context.add_init_script(native_init_source if existing else probe_source)
            handlers.extend((('request', requested), ('response', responded),
                             ('requestfinished', settled), ('requestfailed', lambda request: settled(request, True))))
            for event, callback in handlers:
                context.on(event, callback)
            if existing:
                for page in context.pages:
                    for frame in page.frames:
                        if urlparse(frame.url).path.startswith('/module/dialogue/'):
                            try:
                                frame.evaluate(probe_source)
                                item['existing_runtime_frames'] += 1
                            except Exception:
                                report['diagnostic_errors'].append({'kind': 'existing_frame_probe_setup_failed'})
        except Exception:
            # A probe failure is evidence, never a reason to replace or bypass
            # the unchanged original runner's browser/functional assertions.
            report['diagnostic_errors'].append({'kind': 'probe_setup_failed'})
        return context

    item_state = {}

    def cleanup_context(context):
        item = owned.get(context)
        if item is not None:
            state, handlers = item_state[context]
            if not state['active']:
                return
            state['active'] = False
            try:
                for page in context.pages:
                    for frame in page.frames:
                        if not urlparse(frame.url).path.startswith('/module/dialogue/'):
                            continue
                        try:
                            cleaned = frame.evaluate(native_cleanup_source if item['existing_native_context'] else
                                'window.__r37SseCompletionDiagnosis?.cleanup?.() || {not_installed:true}')
                            item['cleanup'].append({'restored': cleaned.get('restored') is True,
                                                    'not_installed': cleaned.get('not_installed') is True})
                        except Exception:
                            report['diagnostic_errors'].append({'kind': 'probe_cleanup_failed'})
            except Exception:
                report['diagnostic_errors'].append({'kind': 'probe_cleanup_failed'})
            for event, callback in handlers:
                try:
                    context.remove_listener(event, callback)
                except Exception:
                    report['diagnostic_errors'].append({'kind': 'probe_listener_cleanup_failed'})

    def observed_new_context(browser, *positional, **keywords):
        return observe_context(original_new_context(browser, *positional, **keywords), keywords.get('viewport'))

    def observed_close(context, *positional, **keywords):
        cleanup_context(context)
        return original_close(context, *positional, **keywords)

    def observed_connect(browser_kind, *positional, **keywords):
        browser = original_connect(browser_kind, *positional, **keywords)
        try:
            contexts = browser.contexts
            if len(contexts) != 1:
                report['diagnostic_errors'].append({'kind': 'native_context_not_unique'})
            else:
                attached_browsers[browser] = contexts[0]
                observe_context(contexts[0], existing=True)
        except Exception:
            report['diagnostic_errors'].append({'kind': 'native_context_probe_setup_failed'})
        return browser

    def observed_browser_close(browser, *positional, **keywords):
        context = attached_browsers.get(browser)
        if context is not None:
            cleanup_context(context)
        return original_browser_close(browser, *positional, **keywords)

    original_argv = sys.argv
    exit_code = 1
    runner_failure = None
    try:
        BrowserContext.close = observed_close
        if args.runner == 'native':
            browser_type.connect_over_cdp, Browser.close = observed_connect, observed_browser_close
        else:
            Browser.new_context = observed_new_context
        sys.argv = [str(runner), *original_args]
        runpy.run_path(str(runner), run_name='__main__')
        exit_code = 0
    except SystemExit as error:
        exit_code = error.code if isinstance(error.code, int) else 1
    except BaseException as error:
        report['diagnostic_errors'].append({'kind': 'original_runner_raised'})
        runner_failure = error
    finally:
        for context in owned:
            cleanup_context(context)
        sys.argv = original_argv
        Browser.new_context, BrowserContext.close = original_new_context, original_close
        if args.runner == 'native':
            browser_type.connect_over_cdp, Browser.close = original_connect, original_browser_close
        for item in report['contexts']:
            item['reader_request_correlations'] = correlations(item)
            item['producer_limit_reached'] = any(event['kind'] == 'probe_limit_reached' for event in item['reader_events'])
        try:
            report['workspace_hashes_after'] = hashes()
            report['workspace_hashes_unchanged'] = report['workspace_hashes_before'] == report['workspace_hashes_after']
        except Exception:
            report['workspace_hashes_unchanged'] = None
            report['diagnostic_errors'].append({'kind': 'diagnostic_hashes_failed'})
        report['original_runner_exit_code'] = exit_code
        report['original_failure_records_unchanged'] = True
        report['reader_observation_present'] = any(event['kind'] == 'reader_created'
            for item in report['contexts'] for event in item['reader_events'])
        try:
            with args.diagnostic_output.open('x', encoding='utf-8') as evidence:
                evidence.write(json.dumps(report, ensure_ascii=False, indent=2))
            print(json.dumps({'diagnostic_report': str(args.diagnostic_output), 'original_runner_exit_code': exit_code,
                              'contexts': len(report['contexts']), 'workspace_hashes_unchanged': report['workspace_hashes_unchanged']}), flush=True)
        except Exception:
            # A disk/report failure cannot replace the original runner's exit
            # or thrown exception, nor can it manufacture successful evidence.
            print(json.dumps({'diagnostic_error': 'diagnostic_report_write_failed',
                              'original_runner_exit_code': exit_code}), flush=True)
    if runner_failure is not None:
        raise runner_failure
    return exit_code


if __name__ == '__main__':
    raise SystemExit(main())
