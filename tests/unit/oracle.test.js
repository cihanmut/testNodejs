// Oracle rules table.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResponseRecord } from '../../src/execution/http.js';
import { Expectation, Mutation, TestCase } from '../../src/generators/base.js';
import { KnownIssue, Oracle } from '../../src/oracle/oracle.js';
import { FAIL, KNOWN, PASS, WARN } from '../../src/results.js';
import { epiasApi, petv3Api } from '../helpers.js';

function kase(kind, codes = [], group = 'validation', technique = 'A-datatype', rule = 'TYPE-STRING') {
  return new TestCase({
    id: 'TC-x', target: 't', operation_id: 'getPetById', technique, group, field: 'path.petId', rule_id: rule, title: 't',
    mutation: new Mutation('none'), expectation: new Expectation(kind, codes), level: 'standard', needs_auth: false,
  });
}

function resp(status, body = null, ct = 'application/json', ms = 10.0, headers = {}) {
  const raw = body !== null ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  return new ResponseRecord({ status, headers: { 'content-type': ct, ...headers }, body: raw, elapsed_ms: ms });
}

const PET = { id: 1, name: 'x', photoUrls: [] };

const RULES = [
  ['accept', [], 200, PET, PASS],
  ['accept', [], 200, { id: 'x' }, FAIL], // schema mismatch (name/photoUrls missing, id type)
  ['accept', [], 400, null, FAIL], // 4xx for valid input
  ['accept', [], 500, null, FAIL], // 5xx always fails
  ['reject', [400, 404], 400, null, PASS],
  ['reject', [400], 404, null, WARN], // rejected, but with an unexpected code
  ['reject', [400], 200, PET, FAIL], // validation gap
  ['reject', [400], 500, null, FAIL], // 5xx even though... still FAIL
  ['auth_reject', [401, 403], 401, null, PASS],
  ['auth_reject', [401, 403], 200, PET, FAIL], // auth gap
  ['no_5xx', [], 400, null, PASS],
];

for (const [kind, codes, status, body, expected] of RULES) {
  test(`rule ${kind} ${JSON.stringify(codes)} status ${status} -> ${expected}`, async () => {
    const v = new Oracle().evaluate(kase(kind, codes), (await petv3Api()).operation('getPetById'), resp(status, body));
    assert.equal(v.status, expected, v.reason);
  });
}

test('undocumented status is a warning', async () => {
  const op = (await epiasApi()).operation('demand-forecast'); // documents only 200
  const v = new Oracle().evaluate(kase('reject', [400]), op, resp(400));
  assert.equal(v.status, WARN);
  assert.ok(v.findings.some((f) => f.category === 'documentation'));
});

test('slow response is a warning', async () => {
  const v = new Oracle(null, 100).evaluate(kase('accept'), (await petv3Api()).operation('getPetById'), resp(200, PET, 'application/json', 500));
  assert.equal(v.status, WARN);
  assert.match(v.reason, /slow/);
});

test('known issue turns FAIL into KNOWN', async () => {
  const ki = new KnownIssue('KI-1', { operation: 'get*', technique: 'A-*' }, 'weak validation');
  const v = new Oracle([ki]).evaluate(kase('reject', [400]), (await petv3Api()).operation('getPetById'), resp(200, PET));
  assert.equal(v.status, KNOWN);
  assert.equal(v.known_issue, 'KI-1');
});

test('auth redirect must go to the login page', async () => {
  const o = new Oracle(null, 3000, '/cas/login');
  const op = (await petv3Api()).operation('getPetById');
  const good = o.evaluate(kase('auth_reject', [302], 'auth'), op, resp(302, null, 'application/json', 10, { location: 'https://sso/cas/login?service=x' }));
  const bad = o.evaluate(kase('auth_reject', [302], 'auth'), op, resp(302, null, 'application/json', 10, { location: 'https://elsewhere/' }));
  assert.equal(good.status, PASS);
  assert.equal(bad.status, WARN);
});

test('network error is ERROR', async () => {
  const v = new Oracle().evaluate(kase('accept'), (await petv3Api()).operation('getPetById'), new ResponseRecord({ status: null, error: 'ConnectError: boom', error_kind: 'network' }));
  assert.equal(v.status, 'ERROR');
});
