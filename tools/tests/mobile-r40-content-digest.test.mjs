import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { encodedBytesSha256, jsonContentSha256 } from '../../sillytavern-runtime/public/scripts/homer-content-digest.mjs';

const fixtures = [null, '', { data: { name: '合成角色', text: '😀\u0000\ud800' } },
    { b: 1, a: 2, nested: ['worldbook', true, 0, null] }, { data: { name: 'Large fixture', body: '卡\n'.repeat(600000) } }];
for (const [mode, subtle] of [['native', webcrypto.subtle], ['offline fallback', null], ['unusable crypto fallback', { digest: async () => { throw Error('unavailable'); } }]]) {
    test(`exact JSON and captured UTF8 digest match ${mode} including unicode and multi-MB source`, async () => {
        for (const value of fixtures) {
            const body = JSON.stringify(value), bytes = new TextEncoder().encode(body);
            const expected = createHash('sha256').update(body, 'utf8').digest('hex');
            assert.equal(await jsonContentSha256(value, { subtle }), expected);
            assert.equal(await encodedBytesSha256(bytes, { subtle }), expected);
        }
    });
    test(`encoded byte digest matches ${mode} for empty input and an exact view, not its backing buffer`, async () => {
        const source = new TextEncoder().encode('prefix\u0000字😀\ud800-x-\udfff\u0000suffix');
        for (const bytes of [new Uint8Array(), source, source.subarray(6, source.length - 6)]) {
            const expected = createHash('sha256').update(bytes).digest('hex');
            assert.equal(await encodedBytesSha256(bytes, { subtle }), expected);
        }
    });
}
test('invalid/cyclic values reject rather than sharing a digest', async () => {
    await assert.rejects(jsonContentSha256(undefined)); const value = {}; value.self = value;
    await assert.rejects(jsonContentSha256(value));
});
test('encoded byte entry rejects non-byte inputs rather than coercing a different content source', async () => {
    for (const invalid of [undefined, null, '', [], {}, new ArrayBuffer(0), new Uint16Array(1)]) {
        await assert.rejects(encodedBytesSha256(invalid), /Expected encoded Uint8Array bytes/);
    }
});
