import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { notify } from './notify.mjs';
import { loadConfig } from './config.mjs';

test('notify() never throws when no channels are configured (console-only)', async () => {
  const cfg = loadConfig({});
  await assert.doesNotReject(() => notify({ kind: 'high_value_job', title: 't', config: cfg }));
});

test('notify() posts to a configured webhook', async () => {
  let received = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    const cfg = loadConfig({ NOTIFY_WEBHOOK_URL: `http://127.0.0.1:${port}/hook` });
    await notify({ kind: 'application_submitted', title: 'Applied to Acme', body: 'details', config: cfg });
    assert.ok(received);
    assert.match(received.text, /Applied to Acme/);
    assert.equal(received.kind, 'application_submitted');
  } finally {
    server.close();
  }
});

test('notify() does not throw when the webhook is unreachable', async () => {
  const cfg = loadConfig({ NOTIFY_WEBHOOK_URL: 'http://127.0.0.1:1/unreachable' });
  await assert.doesNotReject(() => notify({ kind: 'system_error', title: 'x', config: cfg }));
});
