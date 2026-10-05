"""Pure, synthetic tests for session-card conversion memoization.

This module never imports a running backend or reads account/card files.  The
optional microbenchmark measures this helper only, not end-to-end latency.
"""

import argparse
import copy
import gc
import json
import math
import os
import sys
import threading
import time
import unittest
import weakref
from unittest.mock import patch

SERVER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "server"))
sys.path.insert(0, SERVER_DIR)

from homer_session_cards import SessionCardCache, convert_session_card  # noqa: E402


def card_inputs():
    return (
        {
            "id": 1,
            "updated_at": "unchanged",
            "extra_settings": {
                "unknown": {"retained": ["original"]},
                "mods": [{"id": "m1", "enabled": True}],
                "world_info": {"entries": [{"id": 1, "content": "world"}]},
                "required_policy": {"content": "policy-v1"},
            },
        },
        {"name": "Synthetic", "unknown": {"fallback": "preserved"}},
    )


class CountingConverter:
    def __init__(self):
        self.calls = 0

    def __call__(self, row, fallback):
        self.calls += 1
        return {"row": copy.deepcopy(row), "fallback": copy.deepcopy(fallback)}


class SessionCardCacheTests(unittest.TestCase):
    def setUp(self):
        self.cache = SessionCardCache()
        self.converter = CountingConverter()
        self.row, self.fallback = card_inputs()

    def convert(self, row=None, fallback=None, owner="user-a", conversation="chat-a", converter=None):
        return self.cache.convert(
            converter or self.converter,
            self.row if row is None else row,
            self.fallback if fallback is None else fallback,
            owner_id=owner,
            conversation_id=conversation,
        )

    def test_exact_values_hit_without_json_roundtrip(self):
        with patch.object(json, "dumps", side_effect=AssertionError("no JSON write")), \
                patch.object(json, "loads", side_effect=AssertionError("no JSON read")):
            first = self.convert()
            second = self.convert(copy.deepcopy(self.row), copy.deepcopy(self.fallback))
        self.assertEqual(first, second)
        self.assertIsNot(first, second)
        self.assertEqual(self.converter.calls, 1)

    def test_full_effective_input_changes_not_updated_at_invalidate(self):
        for field in ("unknown", "mods", "world_info", "required_policy"):
            with self.subTest(field=field):
                cache = SessionCardCache()
                converter = CountingConverter()
                row, fallback = card_inputs()
                cache.convert(converter, row, fallback, owner_id="a", conversation_id="c")
                changed = copy.deepcopy(row)
                changed["extra_settings"][field] = {"changed": "complete-content"}
                result = cache.convert(converter, changed, fallback, owner_id="a", conversation_id="c")
                self.assertEqual(converter.calls, 2)
                self.assertEqual(result["row"], changed)
                self.assertEqual(changed["updated_at"], row["updated_at"])

    def test_fallback_fields_are_part_of_key(self):
        self.convert()
        changed = copy.deepcopy(self.fallback)
        changed["unknown"]["fallback"] = "different"
        self.convert(fallback=changed)
        self.assertEqual(self.converter.calls, 2)

    def test_dict_insertion_order_is_exact(self):
        self.convert(row={"a": 1, "b": 2})
        self.convert(row={"b": 2, "a": 1})
        self.assertEqual(self.converter.calls, 2)

    def test_nested_dict_order_is_exact(self):
        self.convert(row={"inner": {"a": 1, "b": 2}})
        self.convert(row={"inner": {"b": 2, "a": 1}})
        self.assertEqual(self.converter.calls, 2)

    def test_list_order_is_exact(self):
        self.convert(row={"items": [1, 2]})
        self.convert(row={"items": [2, 1]})
        self.assertEqual(self.converter.calls, 2)

    def test_primitive_types_and_signed_zero_are_exact(self):
        for left, right in ((False, 0), (1, 1.0), (0.0, -0.0), (None, "None")):
            with self.subTest(left=left, right=right):
                converter = CountingConverter()
                self.convert(row={"value": left}, converter=converter)
                self.convert(row={"value": right}, converter=converter)
                self.assertEqual(converter.calls, 2)

    def test_caller_mutation_of_miss_and_hit_results_does_not_poison_cache(self):
        miss = self.convert()
        miss["row"]["extra_settings"]["unknown"]["retained"].append("bad-miss")
        hit = self.convert()
        self.assertEqual(hit["row"], self.row)
        hit["row"]["extra_settings"]["unknown"]["retained"].append("bad-hit")
        self.assertEqual(self.convert()["row"], self.row)
        self.assertEqual(self.converter.calls, 1)

    def test_input_mutation_after_first_call_invalidates_without_poisoning_old_key(self):
        self.convert()
        self.row["extra_settings"]["unknown"]["retained"].append("new-input")
        self.assertEqual(self.convert()["row"], self.row)
        self.assertEqual(self.converter.calls, 2)

    def test_converter_mutating_input_is_not_cached_under_before_key(self):
        calls = []

        def mutating(row, fallback):
            calls.append(1)
            row["n"] += 1
            return {"n": row["n"]}

        for _ in range(2):
            self.convert(row={"n": 0}, converter=mutating)
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.cache.cache_info()["entries"], 0)

    def test_owner_conversation_and_scope_type_isolation(self):
        for owner, conversation in (("a", "c"), ("b", "c"), ("a", "d"), (1, "c"), ("1", "c")):
            self.convert(owner=owner, conversation=conversation)
        self.assertEqual(self.converter.calls, 5)
        self.convert(owner="a", conversation="c")
        self.assertEqual(self.converter.calls, 5)

    def test_converter_object_identity_isolation(self):
        other = CountingConverter()
        self.convert()
        self.convert(converter=other)
        self.convert()
        self.convert(converter=other)
        self.assertEqual(self.converter.calls, 1)
        self.assertEqual(other.calls, 1)

    def test_converter_unhashable_callable_identity_supported(self):
        class UnhashableConverter(CountingConverter):
            __hash__ = None

            def __eq__(self, other):
                return True

        converter = UnhashableConverter()
        self.convert(converter=converter)
        self.convert(converter=converter)
        self.assertEqual(converter.calls, 1)

    def test_invalid_scope_passes_original_objects_to_converter(self):
        for scope in (None, "", False, 0, -1, [], object()):
            with self.subTest(scope=type(scope).__name__):
                received = []

                def converter(row, fallback):
                    received.append((row is self.row, fallback is self.fallback))
                    return "original"

                self.assertEqual(self.convert(owner=scope, converter=converter), "original")
                self.assertEqual(received, [(True, True)])

    def test_unsupported_input_types_bypass(self):
        class DictSubclass(dict):
            pass

        values = (set([1]), (1, 2), object(), DictSubclass(a=1), {1: "not-string-key"})
        for value in values:
            with self.subTest(value=type(value).__name__):
                calls = []

                def converter(row, fallback):
                    calls.append(row is value)
                    return {"ok": True}

                self.convert(row=value, converter=converter)
                self.convert(row=value, converter=converter)
                self.assertEqual(calls, [True, True])

    def test_nonfinite_values_bypass_without_changes(self):
        for value in (math.nan, math.inf, -math.inf):
            calls = []

            def converter(row, fallback):
                calls.append(row["value"] is value)
                return {"ok": True}

            for _ in range(2):
                self.convert(row={"value": value}, converter=converter)
            self.assertEqual(calls, [True, True])

    def test_cyclic_input_bypasses(self):
        value = {}
        value["cycle"] = value
        calls = []

        def converter(row, fallback):
            calls.append(row["cycle"] is row)
            return {"ok": True}

        for _ in range(2):
            self.convert(row=value, converter=converter)
        self.assertEqual(calls, [True, True])

    def test_depth_limit_bypasses(self):
        cache = SessionCardCache(max_depth=2)
        calls = []

        def converter(row, fallback):
            calls.append(1)
            return {"ok": True}

        for _ in range(2):
            cache.convert(converter, {"a": {"b": {"c": 1}}}, {}, owner_id="a", conversation_id="c")
        self.assertEqual(len(calls), 2)
        self.assertEqual(cache.cache_info()["entries"], 0)

    def test_oversized_input_bypasses(self):
        cache = SessionCardCache(max_bytes=1024)
        converter = CountingConverter()
        for _ in range(2):
            cache.convert(converter, {"large": "x" * 2048}, {}, owner_id="a", conversation_id="c")
        self.assertEqual(converter.calls, 2)
        self.assertEqual(cache.cache_info()["entries"], 0)

    def test_oversized_result_bypasses_storage(self):
        cache = SessionCardCache(max_bytes=2048)
        calls = []

        def converter(row, fallback):
            calls.append(1)
            return {"large": "x" * 4096}

        for _ in range(2):
            result = cache.convert(converter, {}, {}, owner_id="a", conversation_id="c")
            self.assertEqual(len(result["large"]), 4096)
        self.assertEqual(len(calls), 2)
        self.assertEqual(cache.cache_info()["entries"], 0)

    def test_deep_and_nonstring_key_results_bypass_storage(self):
        for result in ({"a": {"b": {"c": 1}}}, {1: "not-string-key"}):
            cache = SessionCardCache(max_depth=2)
            calls = []

            def converter(row, fallback):
                calls.append(1)
                return result

            for _ in range(2):
                self.assertIs(cache.convert(converter, {}, {}, owner_id="a", conversation_id="c"), result)
            self.assertEqual(len(calls), 2)
            self.assertEqual(cache.cache_info()["entries"], 0)

    def test_entry_overhead_is_included_in_bytes_limit(self):
        cache = SessionCardCache(max_bytes=2048)
        converter = CountingConverter()
        for _ in range(2):
            cache.convert(converter, {}, {}, owner_id="a", conversation_id="c")
        self.assertEqual(converter.calls, 2)
        self.assertEqual(cache.cache_info()["entries"], 0)

    def test_result_order_and_nested_types_preserved_on_hit(self):
        row = {"z": [False, 1, 1.0, -0.0, None], "a": {"y": "", "b": []}}
        self.convert(row=row)
        result = self.convert(row=copy.deepcopy(row))["row"]
        self.assertEqual(list(result), ["z", "a"])
        self.assertEqual(list(result["a"]), ["y", "b"])
        self.assertEqual([type(value) for value in result["z"]], [bool, int, float, float, type(None)])
        self.assertEqual(math.copysign(1.0, result["z"][3]), -1.0)
        self.assertEqual(self.converter.calls, 1)

    def test_unsupported_and_cyclic_results_are_returned_unchanged_not_cached(self):
        cyclic = {}
        cyclic["self"] = cyclic
        for result in (object(), cyclic, {"n": math.inf}):
            calls = []

            def converter(row, fallback):
                calls.append(1)
                return result

            self.assertIs(self.convert(converter=converter), result)
            self.assertIs(self.convert(converter=converter), result)
            self.assertEqual(len(calls), 2)

    def test_conversion_exception_identity_and_original_arguments_preserved(self):
        expected = ValueError("synthetic-conversion-failure")

        def converter(row, fallback):
            self.assertIs(row, self.row)
            self.assertIs(fallback, self.fallback)
            raise expected

        for _ in range(2):
            with self.assertRaises(ValueError) as raised:
                self.convert(converter=converter)
            self.assertIs(raised.exception, expected)
        self.assertEqual(self.cache.cache_info()["entries"], 0)

    def test_lru_count_eviction_and_hit_refresh(self):
        cache = SessionCardCache(max_entries=2)
        converter = CountingConverter()

        def convert(conversation):
            cache.convert(converter, {}, {}, owner_id="a", conversation_id=conversation)

        for conversation in ("1", "2", "1", "3", "1", "2"):
            convert(conversation)
        self.assertEqual(converter.calls, 4)
        self.assertEqual(cache.cache_info()["entries"], 2)

    def test_total_bytes_bound_eviction(self):
        cache = SessionCardCache(max_entries=8, max_bytes=5500)
        converter = CountingConverter()
        for index in range(8):
            cache.convert(converter, {"value": str(index) * 1200}, {}, owner_id="a", conversation_id=str(index))
            self.assertLessEqual(cache.cache_info()["bytes"], 5500)
            self.assertLessEqual(cache.cache_info()["entries"], 8)
        self.assertGreater(cache.cache_info()["entries"], 0)
        self.assertLess(cache.cache_info()["entries"], 8)

    def test_changing_same_scope_does_not_grow_entry_count(self):
        for index in range(10):
            self.convert(row={"revision": index})
        self.assertEqual(self.cache.cache_info()["entries"], 1)

    def test_disabled_cache_calls_original_each_time(self):
        for settings in ({"max_entries": 0}, {"max_bytes": 0}):
            cache = SessionCardCache(**settings)
            converter = CountingConverter()
            for _ in range(2):
                cache.convert(converter, {}, {}, owner_id="a", conversation_id="c")
            self.assertEqual(converter.calls, 2)

    def test_constructor_rejects_invalid_limits(self):
        for settings in ({"max_entries": -1}, {"max_bytes": -1}, {"max_depth": 0}, {"max_entries": True}):
            with self.subTest(settings=settings), self.assertRaises(ValueError):
                SessionCardCache(**settings)

    def test_converter_and_cloning_run_outside_lock(self):
        cache = SessionCardCache()
        barrier = threading.Barrier(2)
        errors = []
        results = []

        def converter(row, fallback):
            barrier.wait(timeout=2)
            return {"owner": row["owner"], "nested": [1]}

        def run(owner):
            try:
                results.append(cache.convert(converter, {"owner": owner}, {}, owner_id=owner, conversation_id="c"))
            except Exception as error:
                errors.append(error)

        threads = [threading.Thread(target=run, args=(owner,)) for owner in ("a", "b")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=3)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])
        self.assertEqual({result["owner"] for result in results}, {"a", "b"})
        self.assertEqual(cache.cache_info()["entries"], 2)

    def test_both_miss_storage_and_hit_clones_run_outside_bookkeeping_lock(self):
        original_copy = copy.deepcopy
        checks = []

        def checked_copy(value, *args, **kwargs):
            checks.append(not self.cache._lock.locked())
            return original_copy(value, *args, **kwargs)

        with patch.object(copy, "deepcopy", side_effect=checked_copy):
            self.convert()
            self.convert()
        self.assertGreaterEqual(len(checks), 4)
        self.assertTrue(all(checks))

    def test_unweakrefable_callable_bypasses(self):
        class Converter:
            __slots__ = ("calls",)

            def __init__(self):
                self.calls = 0

            def __call__(self, row, fallback):
                self.calls += 1
                return {"ok": True}

        converter = Converter()
        self.convert(converter=converter)
        self.convert(converter=converter)
        self.assertEqual(converter.calls, 2)
        self.assertEqual(self.cache.cache_info()["entries"], 0)

    def test_cache_does_not_retain_callable_closure_or_object(self):
        converter = CountingConverter()
        reference = weakref.ref(converter)
        self.convert(converter=converter)
        del converter
        gc.collect()
        self.assertIsNone(reference())

    def test_clone_failure_is_optional_miss_not_changed_converter_result(self):
        expected = {"ok": []}
        calls = []

        def converter(row, fallback):
            calls.append(1)
            return expected

        self.convert(converter=converter)
        with patch.object(copy, "deepcopy", side_effect=MemoryError("synthetic-clone-failure")):
            actual = self.convert(converter=converter)
        self.assertIs(actual, expected)
        self.assertEqual(len(calls), 2)

    def test_clear_during_hit_clone_discards_before_clear_entry(self):
        self.convert()
        stored = next(iter(self.cache._entries.values())).result
        original_copy = copy.deepcopy

        def clear_then_copy(value, *args, **kwargs):
            if value is stored:
                self.cache.clear()
            return original_copy(value, *args, **kwargs)

        with patch.object(copy, "deepcopy", side_effect=clear_then_copy):
            result = self.convert()
        self.assertEqual(result["row"], self.row)
        self.assertEqual(self.converter.calls, 2)
        self.assertEqual(self.cache.cache_info()["entries"], 0)

    def test_parallel_calls_remain_bounded_and_results_isolated(self):
        cache = SessionCardCache(max_entries=3, max_bytes=20000)
        barrier = threading.Barrier(8)
        errors = []

        def converter(row, fallback):
            barrier.wait(timeout=3)
            return {"n": row["n"], "items": []}

        def run(index):
            try:
                result = cache.convert(converter, {"n": index}, {}, owner_id="a", conversation_id=str(index))
                self.assertEqual(result["n"], index)
                result["items"].append(index)
            except Exception as error:
                errors.append(error)

        threads = [threading.Thread(target=run, args=(index,)) for index in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=4)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])
        self.assertLessEqual(cache.cache_info()["entries"], 3)
        self.assertLessEqual(cache.cache_info()["bytes"], 20000)

    def test_clear_during_conversion_does_not_republish(self):
        cache = SessionCardCache()
        entered = threading.Event()
        release = threading.Event()

        def converter(row, fallback):
            entered.set()
            self.assertTrue(release.wait(timeout=2))
            return {"ok": True}

        thread = threading.Thread(target=lambda: cache.convert(converter, {}, {}, owner_id="a", conversation_id="c"))
        thread.start()
        self.assertTrue(entered.wait(timeout=2))
        cache.clear()
        release.set()
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(cache.cache_info()["entries"], 0)
        self.assertEqual(cache.cache_info()["bytes"], 0)

    def test_large_complete_strings_are_not_truncated(self):
        value = "合成完整字符串🙂" * 100000
        self.convert(row={"full": value})
        second = self.convert(row={"full": (value + "!")[:-1]})
        self.assertEqual(second["row"]["full"], value)
        self.assertEqual(self.converter.calls, 1)
        self.convert(row={"full": value[:-1] + "a"})
        self.assertEqual(self.converter.calls, 2)

    def test_public_wrapper_smoke_and_independent_scope(self):
        converter = CountingConverter()
        first = convert_session_card(converter, {}, {}, owner_id="synthetic-unit-owner", conversation_id="synthetic-unit-chat")
        second = convert_session_card(converter, {}, {}, owner_id="synthetic-unit-owner", conversation_id="synthetic-unit-chat")
        self.assertEqual(first, second)
        self.assertEqual(converter.calls, 1)


def run_synthetic_benchmark():
    """Whole-string JSON passes emulate conversion cost, not the real server."""
    payload = "x" * (3 * 1024 * 1024)
    row = {"id": 1, "extra_settings": json.dumps({"unknown": payload})}
    fallback = {"name": "Synthetic benchmark"}
    calls = [0]

    def converter(app_data, fallback_card):
        calls[0] += 1
        value = json.loads(app_data["extra_settings"])
        for _ in range(4):
            value = json.loads(json.dumps(value))
        return {"name": fallback_card["name"], "extensions": value}

    cache = SessionCardCache()
    misses = []
    hits = []
    for index in range(5):
        scope = str(index)
        start = time.perf_counter()
        cache.convert(converter, row, fallback, owner_id="benchmark", conversation_id=scope)
        misses.append((time.perf_counter() - start) * 1000)
        start = time.perf_counter()
        cache.convert(converter, row, fallback, owner_id="benchmark", conversation_id=scope)
        hits.append((time.perf_counter() - start) * 1000)
    print("Synthetic helper-only 3MiB benchmark (not end-to-end):")
    print("  samples=5 converter_calls={} miss_mean_ms={:.3f} hit_mean_ms={:.3f}".format(
        calls[0], sum(misses) / len(misses), sum(hits) / len(hits)))
    print("  cache_entries={} estimated_retained_bytes={}".format(
        cache.cache_info()["entries"], cache.cache_info()["bytes"]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark", action="store_true", help="Run synthetic 3MiB helper-only microbenchmark; no backend requests.")
    args = parser.parse_args()
    if args.benchmark:
        run_synthetic_benchmark()
    else:
        unittest.main(argv=[sys.argv[0]], verbosity=2)
