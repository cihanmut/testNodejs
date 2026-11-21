// The denylist is a hard rule: verify that nothing can reach a denylisted host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../../src/cli.js';
import { loadConfig } from '../../src/config/loader.js';
import { BUILTIN_DENYLIST, Denylist, loadDenylist } from '../../src/config/safety.js';
import { SafeHttpClient } from '../../src/execution/http.js';
import { testHooks } from '../../src/runner.js';
import { recordingTransport } from '../fakes.js';
import { CONFIG, runCli, tmpDir } from '../helpers.js';

const EPIAS = 'https://seffaflik.epias.com.tr/electricity-service/v1/consumption/data/consumer-quantity';

test('builtin default is always present', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'safety.yaml'), 'denylist: []\n');
  const dl = loadDenylist(d);
  assert.ok(BUILTIN_DENYLIST.every((h) => dl.hosts.includes(h)));
  assert.ok(dl.isDenied(EPIAS));
});

test('suffix matching', () => {
  const dl = new Denylist(['seffaflik.epias.com.tr']);
  assert.ok(dl.isDenied('https://seffaflik.epias.com.tr/x'));
  assert.ok(dl.isDenied('https://api.seffaflik.epias.com.tr/x'));
  assert.ok(dl.isDenied('SEFFAFLIK.EPIAS.COM.TR:443'));
  assert.ok(!dl.isDenied('https://seffaflik.epias.com.tr.example.com/x'));
  assert.ok(!dl.isDenied('https://not-seffaflik.epias.com.tr/x'));
  assert.ok(!dl.isDenied('https://petstore3.swagger.io/api/v3/pet'));
});

test('denylist key in main config is rejected', () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, 'apitest.yaml'), 'denylist: []\ntargets: {}\n');
  assert.throws(() => loadConfig(path.join(d, 'apitest.yaml')), /denylist/);
});

test('client blocks denylisted host without touching transport', async () => {
  const calls = [];
  const client = new SafeHttpClient(new Denylist(), { transport: recordingTransport(calls), retries: 0 });
  const resp = await client.send('POST', EPIAS, null, Buffer.from('{}'));
  assert.equal(resp.status, null);
  assert.equal(resp.error_kind, 'denied');
  assert.deepEqual(calls, []);
  const ok = await client.get('https://petstore3.swagger.io/api/v3/pet/findByStatus?status=available');
  assert.equal(ok.status, 200);
  assert.equal(calls.length, 1);
});

test('allow once is exactly one GET', async () => {
  const calls = [];
  const url = 'https://seffaflik.epias.com.tr/electricity-service/technical/tr/swagger.json';
  const client = new SafeHttpClient(new Denylist(), { transport: recordingTransport(calls), allow_once_url: url, retries: 0 });
  assert.equal((await client.send('POST', url)).error_kind, 'denied'); // wrong method: still blocked
  assert.equal((await client.get(url)).status, 200); // the one allowed fetch
  assert.equal((await client.get(url)).error_kind, 'denied'); // never twice
  assert.equal((await client.get(EPIAS)).error_kind, 'denied');
  assert.deepEqual(calls, [url]);
});

test('CLI run on denylisted target exits 4 before any request', async () => {
  const calls = [];
  testHooks.transport = recordingTransport(calls);
  try {
    const r = await runCli(main, ['--config', CONFIG, 'run', '--target', 'epias']);
    assert.equal(r.code, 4, r.output);
    assert.match(r.output, /denylist/);
    assert.deepEqual(calls, []);
  } finally {
    testHooks.transport = null;
  }
});

test('CLI dry-run on denylisted target is allowed', async () => {
  const calls = [];
  testHooks.transport = recordingTransport(calls);
  try {
    const r = await runCli(main, ['--config', CONFIG, 'generate', '--target', 'epias', '--dry-run', '--level', 'smoke', '--no-per-operation']);
    assert.equal(r.code, 0, r.output);
    assert.ok(r.output.includes('nothing was sent') && r.output.includes('denylisted'));
    assert.deepEqual(calls, []);
  } finally {
    testHooks.transport = null;
  }
});

test('analyze --spec URL on denylisted host is blocked', async () => {
  const calls = [];
  testHooks.transport = recordingTransport(calls);
  try {
    const r = await runCli(main, ['--config', CONFIG, 'analyze', '--spec', 'https://seffaflik.epias.com.tr/electricity-service/technical/tr/swagger.json']);
    assert.notEqual(r.code, 0);
    assert.deepEqual(calls, []);
  } finally {
    testHooks.transport = null;
  }
});

test('fetch-spec refuses to overwrite', async () => {
  const out = path.join(tmpDir(), 'spec.json');
  fs.writeFileSync(out, '{}');
  const r = await runCli(main, ['--config', CONFIG, 'fetch-spec', 'https://seffaflik.epias.com.tr/electricity-service/technical/tr/swagger.json', '--out', out]);
  assert.equal(r.code, 3);
  assert.match(r.output, /already exists/);
});
