import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { forwardFetchResponse } from '../../sillytavern-runtime/src/util.js';

const require = createRequire(new URL('../../sillytavern-runtime/package.json', import.meta.url));
const { default: fetch, Response } = await import(pathToFileURL(require.resolve('node-fetch')).href);

async function listen(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('actual forwarding preserves SSE metadata and delivers first chunk before upstream EOF', { timeout: 5000 }, async t => {
  let finishUpstream;
  let upstreamEnded = false;
  const upstream = await listen(t, (_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Set-Cookie': 'provider-private=never-forward',
      'Authorization': 'must-not-forward',
      'X-Provider-Secret': 'must-not-forward',
    });
    response.write('data: first\n\n');
    finishUpstream = () => { upstreamEnded = true; response.end('data: [DONE]\n\n'); };
  });
  const bridge = await listen(t, async (_request, response) => {
    await forwardFetchResponse(await fetch(upstream), response);
  });
  const client = await fetch(bridge);
  assert.match(client.headers.get('content-type'), /^text\/event-stream/);
  assert.match(client.headers.get('cache-control'), /no-cache/);
  assert.match(client.headers.get('cache-control'), /no-transform/);
  assert.equal(client.headers.get('x-accel-buffering'), 'no');
  for (const name of ['set-cookie', 'authorization', 'x-provider-secret']) assert.equal(client.headers.get(name), null);
  const first = await once(client.body, 'data');
  assert.match(first[0].toString(), /data: first/);
  assert.equal(upstreamEnded, false, 'SSE first chunk was buffered until EOF');
  const complete = new Promise(resolve => client.body.on('end', resolve));
  finishUpstream();
  await complete;
});

test('actual forwarding retains successful JSON representation and status', { timeout: 5000 }, async t => {
  const body = JSON.stringify({ choices: [{ message: { content: 'synthetic response' } }] });
  const bridge = await listen(t, async (_request, response) => {
    await forwardFetchResponse(new Response(body, { status: 202, statusText: 'Accepted',
      headers: { 'Content-Type': 'application/json; charset=utf-8' } }), response);
  });
  const client = await fetch(bridge);
  assert.equal(client.status, 202);
  assert.equal(client.statusText, 'Accepted');
  assert.match(client.headers.get('content-type'), /^application\/json/);
  assert.equal(client.headers.get('x-accel-buffering'), null);
  assert.equal(await client.text(), body);
});

test('error JSON and original unauthorized-to-400 mapping are preserved', { timeout: 5000 }, async t => {
  const body = JSON.stringify({ error: { message: 'synthetic unauthorized' } });
  const bridge = await listen(t, async (_request, response) => {
    await forwardFetchResponse(new Response(body, { status: 401, statusText: 'Unauthorized',
      headers: { 'Content-Type': 'application/json' } }), response);
  });
  const client = await fetch(bridge);
  assert.equal(client.status, 400);
  assert.equal(client.statusText, 'Unauthorized');
  assert.equal(client.headers.get('content-type'), 'application/json');
  assert.equal(await client.text(), body);
});

test('non-authentication upstream failure retains status and plain text body', { timeout: 5000 }, async t => {
  const body = 'synthetic temporary failure';
  const bridge = await listen(t, async (_request, response) => {
    await forwardFetchResponse(new Response(body, { status: 503, statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain' } }), response);
  });
  const client = await fetch(bridge);
  assert.equal(client.status, 503);
  assert.equal(client.statusText, 'Service Unavailable');
  assert.equal(client.headers.get('content-type'), 'text/plain');
  assert.equal(await client.text(), body);
});

test('client disconnect destroys actual upstream readable rather than completing its pending stream', { timeout: 5000 }, async t => {
  const upstream = new PassThrough();
  const destroyed = once(upstream, 'close');
  let responseEnded = false;
  const bridge = await listen(t, async (_request, response) => {
    response.on('finish', () => { responseEnded = true; });
    await forwardFetchResponse(new Response(upstream, { headers: { 'Content-Type': 'text/event-stream' } }), response);
    upstream.write('data: first\n\n');
  });
  const client = await fetch(bridge);
  await once(client.body, 'data');
  assert.equal(upstream.destroyed, false);
  client.body.destroy();
  await destroyed;
  assert.equal(upstream.destroyed, true);
  // close-handler retains the existing response-end behavior on cancellation.
  assert.equal(responseEnded, false);
});
