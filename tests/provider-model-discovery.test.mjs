import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

test('model discovery retains the original endpoint and authentication for every route protocol', async t => {
  const runtime = path.resolve('.test-runtime');
  fs.mkdirSync(runtime, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(runtime, 'model-discovery-'));
  const received = [];
  let envelope = 'data';
  const upstream = http.createServer((req, res) => {
    received.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.method !== 'GET' || !['/v1/models', '/api/v1/models'].includes(req.url)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Only the original model catalog endpoint is available' } }));
    }
    if (req.headers.authorization !== 'Bearer SYNTHETIC_CATALOG_KEY') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'The model catalog requires Bearer authentication' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      [envelope]: ['gpt-Case', { id: 'Claude/Exact' }, { model: 'deepseek-chat' },
        { slug: 'kimi-k2' }, { name: 'models/gemini-Case' }, { id: 'gpt-Case' }],
      // Catalog discovery must not switch to a protocol-specific pagination flow.
      has_more: true,
      last_id: 'unused-anthropic-cursor',
      nextPageToken: 'unused-gemini-cursor',
    }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  const previous = Object.fromEntries(['GATEWAY_DATA_DIR', 'GATEWAY_EMBEDDED', 'GATEWAY_PORT']
    .map(name => [name, process.env[name]]));
  let gateway;
  try {
    process.env.GATEWAY_DATA_DIR = dataDir;
    process.env.GATEWAY_EMBEDDED = '1';
    process.env.GATEWAY_PORT = '0';
    gateway = await import(`../gateway/gateway.mjs?model-discovery=${Date.now()}`);
    await gateway.startGateway({ port: 0 });
    const origin = `http://127.0.0.1:${gateway.server.address().port}`;
    const post = async (endpoint, body = {}) => {
      const response = await fetch(origin + endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    for (const protocol of ['passthrough', 'chat', 'responses', 'messages', 'gemini']) {
      await t.test(protocol, async () => {
        for (const basePath of ['', '/v1', '/api/v1']) {
          await post('/admin/api/providers', {
            id: 'discovery', name: 'Catalog route', baseUrl: upstreamOrigin + basePath,
            apiKey: 'SYNTHETIC_CATALOG_KEY', upstreamProtocol: protocol,
          });
          for (envelope of ['data', 'models']) {
            received.length = 0;
            const result = await post('/admin/api/providers/discovery/test');
            assert.equal(received.length, 1, 'discovery makes the original single request');
            assert.equal(received[0].method, 'GET');
            assert.equal(received[0].url, basePath === '/api/v1' ? '/api/v1/models' : '/v1/models');
            assert.equal(received[0].headers.authorization, 'Bearer SYNTHETIC_CATALOG_KEY');
            assert.equal(received[0].headers['x-api-key'], undefined);
            assert.equal(received[0].headers['x-goog-api-key'], undefined);
            assert.equal(received[0].headers['anthropic-version'], undefined);
            assert.deepEqual(result.models, ['gpt-Case', 'Claude/Exact', 'deepseek-chat', 'kimi-k2', 'models/gemini-Case']);
          }
        }
      });
    }
  } finally {
    await gateway?.stopGateway();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
