// Phase 2: boundary (C), domain rules (D), protocol negatives (E), response validation (F), store/user
// lifecycles, exports.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { OMIT, RequestTemplate } from '../../src/data/request.js';
import { ValueContext } from '../../src/data/values.js';
import { ResponseRecord } from '../../src/execution/http.js';
import { Expectation, Mutation, TestCase } from '../../src/generators/base.js';
import { Filters } from '../../src/generators/plan.js';
import { RuleError, loadRules } from '../../src/generators/rules.js';
import { Oracle } from '../../src/oracle/oracle.js';
import { extractAll, loadResourceDefs } from '../../src/resources/definitions.js';
import { Resource, ResourceManager } from '../../src/resources/manager.js';
import { EXIT_FAILURES, EXIT_OK, executeRun } from '../../src/runner.js';
import { LoadedSpec } from '../../src/spec/loader.js';
import { normalize } from '../../src/spec/normalize.js';
import { parseAwareDatetime } from '../../src/util/dates.js';
import { FakePetstore } from '../fakes.js';
import { KEY, cfg, epiasApi, fast, petCfg, petv3Api, plan, readJson, results, simpleApi, tmpDir } from '../helpers.js';

before(fast);

// ---------------------------------------------------------------------------------------- rules
test('rule files load and the target file overrides a default', () => {
  const rules = Object.fromEntries(loadRules(cfg().target('epias').rules).map((r) => [r.id, r]));
  assert.ok('DATE-NO-OFFSET' in rules && 'EPIAS-ID-LIST-OVER-1000' in rules);
  assert.equal(rules['RANGE-TOO-LONG'].source, 'epias.yaml'); // same id later in the list replaces the default
});

test('a bad rule is reported', () => {
  const f = path.join(tmpDir(), 'r.yaml');
  fs.writeFileSync(f, 'rules:\n  - id: X\n    kind: value\n    match: {nam: x}\n    value: 1\n');
  assert.throws(() => loadRules([f]), (e) => e instanceof RuleError && /unknown match key/.test(e.message));
});

test('Simple API description rules become cases', async () => {
  const p = plan(cfg(), await simpleApi(), 'simpleapi_offline');
  const create = p.ops.find((x) => x.op.operation_id === 'post_simpleapi_items');
  const rules = Object.fromEntries(create.cases.filter((c) => c.technique === 'D-domain').map((c) => [c.rule_id, c]));
  assert.equal(rules['SIMPLE-PRICE-ABOVE-MAX'].mutation.value, 50000.01);
  assert.equal(rules['SIMPLE-PRICE-MAX'].expectation.kind, 'accept');
  assert.equal(rules['SIMPLE-TYPE-MISSING'].mutation.value, OMIT);
  for (const r of ['SIMPLE-TYPE-VALID#1', 'SIMPLE-TYPE-VALID#2', 'SIMPLE-TYPE-VALID#3']) assert.ok(r in rules);
  const patch = p.ops.find((x) => x.op.operation_id === 'patch_simpleapi_items_id');
  assert.ok(!patch.cases.some((c) => c.rule_id === 'SIMPLE-TYPE-MISSING')); // omit only on create / full update
});

test('EPİAŞ date rules are single-field and valid', async () => {
  const p = plan(cfg(), await epiasApi(), 'epias');
  const op = p.ops.find((x) => x.baseline.body && typeof x.baseline.body === 'object' && 'startDate' in x.baseline.body && 'endDate' in x.baseline.body);
  const byRule = Object.fromEntries(op.cases.filter((c) => c.technique === 'D-domain').map((c) => [c.rule_id, c]));
  const after = byRule['RANGE-START-AFTER-END'];
  assert.deepEqual([...after.mutation.field.path], ['startDate']);
  const start = parseAwareDatetime(after.mutation.value);
  const end = parseAwareDatetime(op.baseline.body.endDate);
  assert.ok(start.epochMs > end.epochMs);
  const tooLong = byRule['RANGE-TOO-LONG'];
  assert.equal(Math.floor((end.epochMs - parseAwareDatetime(tooLong.mutation.value).epochMs) / 86400000), 32);
  assert.equal(byRule['DATE-NO-OFFSET'].mutation.value, '2023-11-14T17:30:00');
  // leap-day accept rule is NOT applied to range members (it would also break the range)
  assert.ok(!op.cases.some((c) => c.rule_id === 'DATE-LEAP-DAY' && ['body.startDate', 'body.endDate'].includes(c.field)));
  assert.ok(op.cases.some((c) => c.rule_id === 'PAGE-SIZE-ZERO'));
});

test('EPİAŞ id-list rules', async () => {
  const cases = plan(cfg(), await epiasApi(), 'epias').cases.filter((c) => ['EPIAS-ID-LIST-OVER-1000', 'EPIAS-ID-LIST-DUPLICATES'].includes(c.rule_id));
  assert.ok(cases.length);
  assert.equal(cases.find((c) => c.rule_id === 'EPIAS-ID-LIST-OVER-1000').mutation.value.length, 1001);
  const dup = cases.find((c) => c.rule_id === 'EPIAS-ID-LIST-DUPLICATES');
  assert.deepEqual(dup.mutation.value[0], dup.mutation.value[1]);
});

// ---------------------------------------------------------------------------------------- boundary
function mini(props, required = []) {
  const raw = {
    openapi: '3.0.0', info: { title: 't', version: '1' },
    paths: { '/things': { post: { operationId: 'make', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required, properties: props } } } }, responses: { 200: { description: 'ok' } } } } },
  };
  return normalize(new LoadedSpec(raw, JSON.stringify(raw), 'inline', null, 'x'));
}

test('boundaries from constraints', () => {
  const api = mini({
    qty: { type: 'integer', minimum: 1, maximum: 10, example: 5 },
    code: { type: 'string', minLength: 2, maxLength: 4, example: 'abc' },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 3, uniqueItems: true },
  });
  const p = plan(cfg(), api, 'simpleapi_offline'); // any target: no rules match these fields
  const c = Object.fromEntries(p.cases.filter((x) => x.technique === 'C-boundary').map((x) => [`${x.field}|${x.rule_id}`, x]));
  assert.equal(c['body.qty|MIN-MINUS-1'].mutation.value, 0);
  assert.equal(c['body.qty|MIN-MINUS-1'].expectation.kind, 'reject');
  assert.equal(c['body.qty|MIN'].expectation.kind, 'accept');
  assert.equal(c['body.qty|MAX-PLUS-1'].mutation.value, 11);
  assert.equal(c['body.code|MAXLEN-PLUS-1'].mutation.value.length, 5);
  assert.equal(c['body.code|MINLEN-MINUS-1'].mutation.value, 'a');
  assert.equal(c['body.tags|MAXITEMS-PLUS-1'].mutation.value.length, 4);
  const dup = c['body.tags|DUPLICATE-ITEMS'].mutation.value;
  assert.equal(dup[0], dup[1]);
  assert.deepEqual(p.findings, []); // every field had a constraint
});

test('generic limits are full level and documented', () => {
  const api = mini({ qty: { type: 'integer', example: 5 }, name: { type: 'string', example: 'x' } });
  const std = plan(cfg(), api, 'simpleapi_offline', { level: 'standard' });
  assert.ok(!std.cases.some((x) => x.rule_id.startsWith('GENERIC')));
  const full = plan(cfg(), api, 'simpleapi_offline', { level: 'full' });
  const generic = full.cases.filter((x) => x.rule_id.startsWith('GENERIC'));
  assert.ok(generic.length && generic.every((x) => x.expectation.kind === 'no_5xx'));
  const kinds = full.findings.map((f) => `${f.kind}|${f.message.split(': ').pop()}`);
  assert.ok(kinds.includes('constraint_missing|no minimum/maximum documented in the spec'));
});

// ---------------------------------------------------------------------------------------- protocol
test('protocol cases and 405 safety', async () => {
  const p = plan(petCfg(), await petv3Api(), 'petstore_v3_offline');
  const byOp = Object.fromEntries(p.ops.map((x) => [x.op.operation_id, x]));
  const add = new Set(byOp.addPet.cases.map((c) => c.rule_id));
  for (const r of ['E-MALFORMED-JSON', 'E-EMPTY-BODY', 'E-BODY-AS-ARRAY', 'E-CONTENT-TYPE-TEXT', 'E-UNKNOWN-FIELD']) assert.ok(add.has(r), r);
  const methods = p.ops.flatMap((x) => x.cases.filter((c) => c.rule_id === 'E-METHOD-NOT-ALLOWED').map((c) => [x.op.path, c.mutation.value.method]));
  assert.ok(methods.some(([pp, m]) => pp === '/pet' && m === 'GET')); // GET is always safe
  for (const [pp, m] of methods) if (m !== 'GET') assert.ok(pp.includes('{'), `${pp} ${m}`); // writes only on our own item paths
  assert.equal(p.cases.filter((c) => c.rule_id === 'E-UNKNOWN-PATH').length, 1);
  const nf = byOp.getPetById.cases.filter((c) => c.rule_id === 'E-NOT-FOUND');
  assert.ok(nf.length && nf[0].mutation.kind === 'tombstone');
  assert.deepEqual([...nf[0].expectation.codes], [404]);
});

test('string ids are never mutated on writes', async () => {
  const p = plan(petCfg(), await petv3Api(), 'petstore_v3_offline', { level: 'full' });
  const byOp = Object.fromEntries(p.ops.map((x) => [x.op.operation_id, x]));
  for (const opId of ['updateUser', 'deleteUser', 'createUser']) {
    for (const c of byOp[opId].cases) if (c.mutation.kind === 'set') assert.ok(!['path.username', 'body.username'].includes(c.field), `${opId} ${c.rule_id}`);
  }
  for (const c of byOp.createUsersWithListInput.cases) if (c.mutation.kind === 'set') assert.notEqual(c.field, 'body[0].username', c.rule_id);
  assert.ok(byOp.getUserByName.cases.some((c) => c.field === 'path.username')); // reads may mutate it
});

// ---------------------------------------------------------------------------------------- oracle F
const baseCase = (kind = 'accept', codes = []) => new TestCase({
  id: 'TC-x', target: 't', operation_id: 'o', technique: 'BASE', group: 'baseline', field: null, rule_id: 'BASELINE', title: 't',
  mutation: new Mutation('none'), expectation: new Expectation(kind, codes), level: 'smoke', needs_auth: false,
});
const jsonResp = (status, text) => new ResponseRecord({ status, headers: { 'content-type': 'application/json' }, body: Buffer.from(text) });

test('error envelope inside a 200 fails', async () => {
  const op = (await simpleApi()).operation('get_simpleapi_randomisbn');
  const oracle = new Oracle(null, 3000, null, { path: 'errorMessages', fail_if_present: true, ok_values: null });
  assert.equal(oracle.evaluate(baseCase(), op, jsonResp(200, '{"errorMessages": ["boom"]}')).status, 'FAIL');
  assert.equal(oracle.evaluate(baseCase(), op, jsonResp(200, '{"isbn": "x"}')).status, 'PASS');
  const codes = new Oracle(null, 3000, null, { path: 'resultCode', ok_values: ['0'], fail_if_present: false });
  assert.equal(codes.evaluate(baseCase(), op, jsonResp(200, '{"resultCode": "E12"}')).status, 'FAIL');
});

test('error body not matching its schema is a warning', async () => {
  const op = (await simpleApi()).operation('post_simpleapi_items'); // documents 400 with ThingifierError
  const v = new Oracle().evaluate(baseCase('reject', [400]), op, jsonResp(400, '{"message": "nope"}'));
  assert.equal(v.status, 'WARN');
  assert.match(v.reason, /documented schema/);
});

// ---------------------------------------------------------------------------------------- lifecycle
test('store and user lifecycle on the fake', async () => {
  const fake = new FakePetstore({ apiKey: KEY });
  const [runDir, code] = await executeRun(petCfg(), 'petstore_v3_offline', {
    level: 'standard', filters: new Filters({ tags: ['store', 'user'] }), credential: KEY, runsDir: tmpDir(), transport: fake.transport(), echo: () => {},
  });
  const rs = results(runDir);
  const bases = Object.fromEntries(rs.filter((r) => r.case.technique === 'BASE').map((r) => [r.operation.operation_id, r]));
  const bad = Object.fromEntries(Object.entries(bases).filter(([, v]) => !['PASS', 'WARN'].includes(v.status)).map(([k, v]) => [k, v.reason]));
  assert.deepEqual(bad, {});
  assert.ok([EXIT_OK, EXIT_FAILURES].includes(code));
  // everything we created is gone; other users' data untouched (the fake throws on foreign writes)
  assert.deepEqual(new Set(fake.orders.keys()), fake.foreign_orders);
  assert.deepEqual([...fake.users.keys()], ['theUser']);
  assert.deepEqual(readJson(path.join(runDir, 'run.json')).cleanup, []);
  // every write to /user/{name} used one of our names
  for (const req of fake.requests) {
    const m = /^\/api\/v3\/user\/([^/]+)$/.exec(req.url.pathname);
    if (m && ['PUT', 'DELETE'].includes(req.method) && !['login', 'logout'].includes(m[1])) assert.ok(m[1].startsWith('apitest_'), req.url.href);
  }
  // Phase 2 cases ran: protocol + not-found
  assert.ok(rs.some((r) => r.case.rule_id === 'E-NOT-FOUND' && r.status === 'PASS'));
  assert.ok(rs.some((r) => r.case.rule_id === 'E-MALFORMED-JSON' && r.status === 'PASS'));
  // exports written
  const junit = fs.readFileSync(path.join(runDir, 'junit.xml'), 'utf8');
  assert.equal(Number(/<testsuites [^>]*tests="(\d+)"/.exec(junit)[1]), rs.length);
  assert.ok(fs.existsSync(path.join(runDir, 'results.csv')) && fs.existsSync(path.join(runDir, 'results.xlsx')));
});

test('free-id probe skips taken ids', async () => {
  const defs = loadResourceDefs(petCfg().target('petstore_v3_offline').resources);
  const probed = [];
  const sender = { sendTemplate: async (op, tpl) => { probed.push(tpl.path.orderId); return [new ResponseRecord({ status: probed.length < 3 ? 200 : 404 }), {}]; } };
  const builder = { ctx: new ValueContext('R1', 42), build: () => new RequestTemplate() };
  const mgr = new ResourceManager(await petv3Api(), defs, builder, sender);
  const free = await mgr.freeId('order');
  assert.equal(free, probed[probed.length - 1]);
  assert.equal(probed.length, 3);
  assert.ok(free >= 11 && free <= 999);
});

test('wildcard extraction', () => {
  assert.deepEqual(extractAll([{ username: 'a' }, { username: 'b' }], '*.username'), ['a', 'b']);
  assert.deepEqual(extractAll({ items: [{ id: 1 }] }, 'items.*.id'), [1]);
});

test('delete verification waits for eventual consistency', async () => {
  const defs = loadResourceDefs(petCfg().target('petstore_v3_offline').resources);
  const answers = [200, 200, 200, 404]; // delete ok, then GET 200, 200, 404
  const sleeps = [];
  const sender = { sendTemplate: async () => [new ResponseRecord({ status: answers.shift() }), {}] };
  const builder = { build: () => new RequestTemplate() };
  const saved = ResourceManager.VERIFY_BACKOFF_S;
  ResourceManager.VERIFY_BACKOFF_S = 1.0;
  try {
    const mgr = new ResourceManager(await petv3Api(), defs, builder, sender, null, async (s) => { sleeps.push(s); });
    assert.equal(await mgr.delete(new Resource('user', 'apitest_x')), null);
    assert.deepEqual(sleeps, [1, 2]); // two waits (1s, 2s) before the third GET saw 404
  } finally {
    ResourceManager.VERIFY_BACKOFF_S = saved;
  }
});
