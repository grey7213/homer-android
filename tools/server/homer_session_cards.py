"""Bounded, exact-input memoization of the pure session-card conversion.

Use only after fresh authorization, version/mod/worldbook/runtime overlays and
fresh fallback-card creation.  This helper is not an authorization, row, file,
message, token or offline cache.  It does not move or suppress those operations.

Inputs are compared as complete, typed, insertion-order-preserving JSON-shaped
values, without serializing or hashing their large strings.  Changed unknown
fields invalidate just like known fields.  The converter must be deterministic
for these values and must not depend on mutable state omitted from the inputs.

Limits bound cache-owned snapshots/results using conservative Python object
sizes, not total process RSS or transient caller/converter allocations.  A weak
converter reference avoids retaining an arbitrary callable's closure/state.
Conversion and deep copies run outside the bookkeeping lock.  Concurrent misses
may compute independently; this is deliberately not a single-flight wrapper.
"""

import copy
import math
import sys
import threading
import weakref
from collections import OrderedDict
from dataclasses import dataclass


class _CacheBypass(Exception):
    """Input/result is unsuitable for this optional optimization."""


class _SnapshotBuilder:
    def __init__(self, max_depth, max_bytes):
        self.max_depth = max_depth
        self.max_bytes = max_bytes
        self.bytes = 0
        self.seen = set()
        self.ancestors = set()

    def charge(self, value):
        identity = id(value)
        if identity not in self.seen:
            self.seen.add(identity)
            self.bytes += sys.getsizeof(value)
            if self.bytes > self.max_bytes:
                raise _CacheBypass()
        return value

    def freeze(self, value, depth=0):
        if depth > self.max_depth:
            raise _CacheBypass()
        value_type = type(value)
        if value_type is type(None):
            return self.charge((0,))
        if value_type is bool:
            self.charge(value)
            return self.charge((1, value))
        if value_type is int:
            self.charge(value)
            return self.charge((2, value))
        if value_type is float:
            if not math.isfinite(value):
                raise _CacheBypass()
            # hex preserves -0.0 and the exact finite binary float value.
            return self.charge((3, self.charge(value.hex())))
        if value_type is str:
            return self.charge((4, self.charge(value)))
        if value_type not in (list, dict):
            raise _CacheBypass()
        identity = id(value)
        if identity in self.ancestors:
            raise _CacheBypass()
        self.ancestors.add(identity)
        try:
            if value_type is list:
                children = []
                for item in value:
                    children.append(self.freeze(item, depth + 1))
                return self.charge((5, self.charge(tuple(children))))
            children = []
            for key, item in value.items():
                if type(key) is not str:
                    raise _CacheBypass()
                children.append(self.charge((self.charge(key), self.freeze(item, depth + 1))))
            return self.charge((6, self.charge(tuple(children))))
        finally:
            self.ancestors.remove(identity)


def _snapshot(app_data, fallback_card, max_depth, max_bytes):
    builder = _SnapshotBuilder(max_depth, max_bytes)
    return builder.charge((builder.freeze(app_data), builder.freeze(fallback_card)))


def _json_graph_size(value, max_depth, max_bytes, allow_tuples=False):
    """Validate and size only plain objects; never invoke custom object hooks."""
    seen = set()
    ancestors = set()
    total = 0

    def visit(item, depth):
        nonlocal total
        if depth > max_depth:
            raise _CacheBypass()
        item_type = type(item)
        if item_type not in (type(None), bool, int, float, str, list, dict) and not (
                allow_tuples and item_type is tuple):
            raise _CacheBypass()
        if item_type is float and not math.isfinite(item):
            raise _CacheBypass()
        identity = id(item)
        if identity in ancestors:
            raise _CacheBypass()
        if identity in seen:
            return
        seen.add(identity)
        total += sys.getsizeof(item)
        if total > max_bytes:
            raise _CacheBypass()
        if item_type in (list, tuple, dict):
            ancestors.add(identity)
            try:
                if item_type is dict:
                    for key, child in item.items():
                        if type(key) is not str:
                            raise _CacheBypass()
                        visit(key, depth + 1)
                        visit(child, depth + 1)
                else:
                    for child in item:
                        visit(child, depth + 1)
            finally:
                ancestors.remove(identity)

    visit(value, 0)
    return total


def _valid_scope(value):
    return (type(value) is str and bool(value)) or (type(value) is int and value > 0)


def _scope_key(value):
    return (0 if type(value) is str else 1, value)


@dataclass(frozen=True)
class _Entry:
    converter_ref: object
    snapshot: tuple
    result: object
    size: int


class SessionCardCache:
    """Small thread-safe LRU; no shared mutable card result escapes the cache.

    Uncacheable inputs/results still run and return the original converter.
    ``owner_id`` and ``conversation_id`` are explicit, nonempty strings or
    positive integers.  Their types are retained; 1 and "1" are separate scopes.
    """

    # Includes entry instance/dictionary, weakref and OrderedDict-node overhead;
    # graphs/key tuples are additionally counted by sys.getsizeof traversal.
    _ENTRY_OVERHEAD = 1024

    def __init__(self, max_entries=8, max_bytes=32 * 1024 * 1024, max_depth=64):
        if type(max_entries) is not int or max_entries < 0:
            raise ValueError("max_entries must be a nonnegative integer")
        if type(max_bytes) is not int or max_bytes < 0:
            raise ValueError("max_bytes must be a nonnegative integer")
        if type(max_depth) is not int or max_depth < 1:
            raise ValueError("max_depth must be a positive integer")
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self.max_depth = max_depth
        self._entries = OrderedDict()
        self._bytes = 0
        self._epoch = 0
        self._lock = threading.Lock()

    def convert(self, converter, app_data, fallback_card, *, owner_id, conversation_id):
        """Memoize only the full effective input pair in the given account/chat.

        ``converter(app_data, fallback_card)`` receives the original arguments
        exactly once on a miss/bypass.  Its exception is never caught here.
        """
        if not self.max_entries or not self.max_bytes or not (
                _valid_scope(owner_id) and _valid_scope(conversation_id)):
            return converter(app_data, fallback_card)
        try:
            converter_ref = weakref.ref(converter)
            key = (id(converter), _scope_key(owner_id), _scope_key(conversation_id))
            snapshot = _snapshot(app_data, fallback_card, self.max_depth, self.max_bytes)
        except (_CacheBypass, TypeError, RecursionError, RuntimeError):
            return converter(app_data, fallback_card)

        with self._lock:
            epoch = self._epoch
            candidate = self._entries.get(key)
        if candidate is not None and candidate.converter_ref() is converter and candidate.snapshot == snapshot:
            # A result can be large: never deep-copy while holding the LRU lock.
            try:
                cloned = copy.deepcopy(candidate.result)
            except (RecursionError, MemoryError):
                cloned = None
            else:
                with self._lock:
                    if epoch == self._epoch:
                        if self._entries.get(key) is candidate:
                            self._entries.move_to_end(key)
                        return cloned

        # Keep this call outside all cache exception handlers and the lock.
        result = converter(app_data, fallback_card)
        try:
            # Do not publish a before-key for a converter that mutates its input.
            if _snapshot(app_data, fallback_card, self.max_depth, self.max_bytes) != snapshot:
                return result
            _json_graph_size(result, self.max_depth, self.max_bytes)
            stored = copy.deepcopy(result)
            # Frozen input adds at most two structural tuple layers per level.
            retained = _json_graph_size((key, snapshot, stored), self.max_depth * 2 + 8,
                                        self.max_bytes, allow_tuples=True)
            retained += self._ENTRY_OVERHEAD
            if retained > self.max_bytes:
                return result
            entry = _Entry(converter_ref, snapshot, stored, retained)
        except (_CacheBypass, RecursionError, RuntimeError, MemoryError):
            return result

        with self._lock:
            if epoch != self._epoch:
                return result
            previous = self._entries.pop(key, None)
            if previous is not None:
                self._bytes -= previous.size
            self._entries[key] = entry
            self._bytes += entry.size
            while len(self._entries) > self.max_entries or self._bytes > self.max_bytes:
                _, evicted = self._entries.popitem(last=False)
                self._bytes -= evicted.size
        return result

    def clear(self):
        """Discard entries; an older in-flight conversion cannot republish them."""
        with self._lock:
            self._epoch += 1
            self._entries.clear()
            self._bytes = 0

    def cache_info(self):
        """Return bounded counters/configuration only, never account/card data."""
        with self._lock:
            return {
                "entries": len(self._entries),
                "bytes": self._bytes,
                "max_entries": self.max_entries,
                "max_bytes": self.max_bytes,
            }


_session_card_cache = SessionCardCache()


def convert_session_card(converter, app_data, fallback_card, *, owner_id, conversation_id):
    """Default 8-entry/32MiB memo; call only after fresh session authorization."""
    return _session_card_cache.convert(
        converter, app_data, fallback_card,
        owner_id=owner_id, conversation_id=conversation_id,
    )
