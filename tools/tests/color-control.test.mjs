import test from 'node:test';
import assert from 'node:assert/strict';
import { colorChannels, channelsColor } from '../../frontend/assets/js/color-control.mjs';
test('inline color conversion retains six-digit colors and rejects invalid drafts', () => {
    assert.deepEqual(colorChannels('#29485f'), [41, 72, 95]);
    assert.deepEqual(colorChannels('#AAbBcc'), [170, 187, 204]);
    for (const value of ['red', '#abc', '#1234567', '', null]) assert.equal(colorChannels(value), null);
    assert.equal(channelsColor([41, 72, 95]), '#29485f');
    assert.equal(channelsColor([-20, 500, 4.5]), '#00ff05');
    for (const value of ['#000000','#ffffff','#29485f','#e6aa03']) assert.equal(channelsColor(colorChannels(value)),value);
});
