import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { encodedBytesSha256, jsonContentSha256 } from '../../sillytavern-runtime/public/scripts/homer-content-digest.mjs';

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const unavailableSubtle = { digest: async () => { throw new Error('unavailable'); } };
const fixtures = [null, '', 0, false, '中英 mixed 😀\n\u0000',
    { emoji: '😀', escaped: '\ud800-x-\udfff', line: 'first\nsecond', zero: '\u0000' }];

for (const subtle of [null, unavailableSubtle]) {
    test(`JSON uses the exact native UTF8 string and receiver when subtle is ${subtle ? 'unusable' : 'missing'}`, async () => {
        const bodies = [];
        const bridge = { sha256Utf8(body) {
            assert.equal(this, bridge);
            bodies.push(body);
            return sha256(body);
        } };
        for (const value of fixtures) {
            assert.equal(await jsonContentSha256(value, { subtle, nativeBridge: bridge }), sha256(JSON.stringify(value)));
        }
        assert.deepEqual(bodies, fixtures.map(value => JSON.stringify(value)));
        assert.match(bodies.at(-1), /\\ud800-x-\\udfff/);
    });
}

test('working SubtleCrypto stays first and does not call the native bridge', async () => {
    const bridge = { sha256Utf8() { throw new Error('native must not run'); } };
    for (const value of fixtures) {
        assert.equal(await jsonContentSha256(value, { subtle: webcrypto.subtle, nativeBridge: bridge }), sha256(JSON.stringify(value)));
    }
});

test('JSON serialization is captured once before a native fallback', async () => {
    let captures = 0;
    const value = { toJSON() { captures += 1; return { text: 'captured 😀' }; } };
    const bridge = { sha256Utf8() { throw new Error('unavailable'); } };
    assert.equal(await jsonContentSha256(value, { subtle: null, nativeBridge: bridge }), sha256('{"text":"captured 😀"}'));
    assert.equal(captures, 1);
});

test('missing, throwing, non-callable and invalid native results keep the complete browser fallback', async () => {
    const expected = sha256(JSON.stringify(fixtures.at(-1)));
    const invalidResults = [undefined, null, '', true, 7, 'a'.repeat(63), 'a'.repeat(65),
        'A'.repeat(64), 'g'.repeat(64), `${'a'.repeat(64)}\n`, Promise.resolve('a'.repeat(64))];
    const bridges = [null, {}, { sha256Utf8: 4 }, { sha256Utf8() { throw new Error('unavailable'); } },
        ...invalidResults.map(result => ({ sha256Utf8() { return result; } }))];
    for (const bridge of bridges) {
        assert.equal(await jsonContentSha256(fixtures.at(-1), { subtle: null, nativeBridge: bridge }), expected);
    }
});

test('throwing bridge accessors cannot prevent the original browser digest', async () => {
    const bridge = Object.defineProperty({}, 'sha256Utf8', { get() { throw new Error('unavailable'); } });
    assert.equal(await jsonContentSha256('safe', { subtle: null, nativeBridge: bridge }), sha256('"safe"'));
});

test('default native bridge lookup retains the injected receiver and lookup errors fall back', async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'HomerNative');
    const bridge = { sha256Utf8(body) { assert.equal(this, bridge); return sha256(body); } };
    try {
        Object.defineProperty(globalThis, 'HomerNative', { configurable: true, value: bridge });
        assert.equal(await jsonContentSha256('default 😀', { subtle: null }), sha256('"default 😀"'));
        Object.defineProperty(globalThis, 'HomerNative', { configurable: true, get() { throw new Error('unavailable'); } });
        assert.equal(await jsonContentSha256('default fallback', { subtle: null }), sha256('"default fallback"'));
    } finally {
        if (previous) Object.defineProperty(globalThis, 'HomerNative', previous);
        else delete globalThis.HomerNative;
    }
});

test('a native size refusal falls back without dropping any JSON bytes', async () => {
    const value = { text: '中😀'.repeat(150000) };
    const bridge = { sha256Utf8(body) { assert.ok(new TextEncoder().encode(body).length > 1024 * 1024); return ''; } };
    assert.equal(await jsonContentSha256(value, { subtle: null, nativeBridge: bridge }), sha256(JSON.stringify(value)));
});

test('encoded bytes never call a UTF8 bridge or change exact arbitrary-byte/view semantics', async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'HomerNative');
    let calls = 0;
    try {
        Object.defineProperty(globalThis, 'HomerNative', { configurable: true, value: {
            sha256Utf8() { calls += 1; throw new Error('byte entry must not use native text'); },
        } });
        const source = new Uint8Array([0xff, 0x00, 0xc0, 0x80, 0xf0, 0x28, 0x8c, 0xbc]);
        for (const bytes of [source, source.subarray(1, 7), new Uint8Array()]) {
            for (const subtle of [null, unavailableSubtle, webcrypto.subtle]) {
                assert.equal(await encodedBytesSha256(bytes, { subtle }), createHash('sha256').update(bytes).digest('hex'));
            }
        }
        assert.equal(calls, 0);
    } finally {
        if (previous) Object.defineProperty(globalThis, 'HomerNative', previous);
        else delete globalThis.HomerNative;
    }
});

test('invalid JSON cannot call the native bridge', async () => {
    let calls = 0;
    const bridge = { sha256Utf8() { calls += 1; return 'a'.repeat(64); } };
    const cyclic = {}; cyclic.self = cyclic;
    for (const value of [undefined, () => {}, cyclic]) {
        await assert.rejects(jsonContentSha256(value, { subtle: null, nativeBridge: bridge }));
    }
    assert.equal(calls, 0);
});
