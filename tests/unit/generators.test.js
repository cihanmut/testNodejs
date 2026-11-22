// Generation rules: single mutation, determinism, auth header exclusion, ownership guard, baselines.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { FieldRef, FileValue, NO_BODY, OMIT, ResourceRef } from '../../src/data/request.js';
import { ownershipSafe } from '../../src/generators/base.js';
import { Filters } from '../../src/generators/plan.js';
import { inferBindings, loadResourceDefs } from '../../src/resources/definitions.js';
import { loadSpecSource } from '../../src/spec/loader.js';
import { normalize } from '../../src/spec/normalize.js';
import { dumps, isPlainObject } from '../../src/util/json.js';
import { FIXTURES, cfg, epiasApi, petCfg, petv3Api, plan } from '../helpers.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

/** compare as JSON (true != 1), sentinels by repr */
function j(v) {
  if (v === OMIT || v instanceof ResourceRef || v instanceof FileValue) return v.repr() + (v instanceof FileValue ? v.data.toString('hex') : '');
  return dumps(v, { sortKeys: true });
}

function flatten(tpl) {
  const out = new Map();
  for (const [loc, sec] of [['path', tpl.path], ['query', tpl.query], ['header', tpl.headers]]) for (const [k, v] of Object.entries(sec)) out.set(JSON.stringify([loc, k]), v);
  const walk = (v, p) => {
    if (isPlainObject(v)) for (const [k, x] of Object.entries(v)) walk(x, [...p, k]);
    else if (Array.isArray(v) && v.length && isPlainObject(v[0])) v.forEach((x, i) => walk(x, [...p, i]));
    else out.set(JSON.stringify(['body', ...p]), v);
  };
  if (isPlainObject(tpl.body) || Array.isArray(tpl.body)) walk(tpl.body, []);
  else if (tpl.body !== NO_BODY) out.set(JSON.stringify(['body']), tpl.body); // binary upload etc.
  return out;
}

for (const [target, apiFn, conf] of [['epias_offline', epiasApi, petCfg], ['petstore_v3_offline', petv3Api, petCfg]]) {
  test(`every case changes exactly one thing (${target})`, async () => {
    const p0 = plan(conf(), await apiFn(), target, { level: 'full' });
    let checked = 0;
    for (const p of p0.ops) {
      const base = flatten(p.baseline);
      for (const c of p.cases) {
        if (c.mutation.kind !== 'set') continue;
        const tpl = p.baseline.copy();
        tpl.set(c.mutation.field, c.mutation.value);
        const after = flatten(tpl);
        const keys = new Set([...base.keys(), ...after.keys()]);
        const changed = [...keys].filter((k) => j(base.has(k) ? base.get(k) : OMIT) !== j(after.has(k) ? after.get(k) : OMIT));
        assert.ok(changed.length, c.id);
        const f = c.mutation.field;
        for (const k of changed) {
          const kk = JSON.parse(k);
          if (f.location === 'body') {
            assert.equal(kk[0], 'body', `${c.id} ${k}`);
            assert.deepEqual(kk.slice(1, 1 + f.path.length), [...f.path], `${c.id} ${k}`);
          } else {
            assert.deepEqual(kk, [f.location, f.path[0]], `${c.id} ${k}`);
          }
        }
        checked += 1;
      }
    }
    assert.ok(checked > 50);
  });
}

test('generation is deterministic', async () => {
  const api = await epiasApi();
  const a = plan(petCfg(), api, 'epias_offline', { runId: 'A' }).cases.map((c) => c.id);
  const b = plan(petCfg(), api, 'epias_offline', { runId: 'B' }).cases.map((c) => c.id);
  assert.deepEqual(a, b);
  assert.equal(a.length, new Set(a).size);
});

test('auth header only in the auth group', async () => {
  for (const [api, target, header, conf] of [[await epiasApi(), 'epias_offline', 'header.TGT', petCfg()], [await petv3Api(), 'petstore_v3_offline', 'header.api_key', petCfg()]]) {
    for (const c of plan(conf, api, target, { level: 'full' }).cases) if (c.field === header) assert.equal(c.technique, 'AUTH', c.id);
  }
});

test('no-credential matrix cases exist', async () => {
  const p = plan(petCfg(), await epiasApi(), 'epias_offline', { level: 'smoke' });
  const op = p.ops.find((x) => x.op.operation_id === 'consumer-quantity');
  assert.deepEqual(op.cases.filter((c) => c.technique === 'AUTH').map((c) => c.rule_id), ['AUTH-MISSING', 'AUTH-EMPTY', 'AUTH-MALFORMED', 'AUTH-WRONG-PREFIX']);
  const pub = p.ops.find((x) => x.op.operation_id === 'demand-forecast');
  assert.deepEqual(pub.cases.map((c) => c.technique), ['BASE']);
});

test('EPİAŞ baseline dates and paging', async () => {
  const p = plan(petCfg(), await epiasApi(), 'epias_offline');
  const bodies = p.ops.map((x) => x.baseline.body).filter(isPlainObject);
  const withRange = bodies.filter((b) => 'startDate' in b && 'endDate' in b);
  assert.ok(withRange.length);
  for (const b of withRange) {
    assert.match(b.startDate, DATE_RE);
    assert.match(b.endDate, DATE_RE);
    assert.ok(b.startDate < b.endDate, JSON.stringify(b)); // example pairs were equal -> fixed to a valid range
  }
  const paged = bodies.filter((b) => isPlainObject(b.page));
  assert.ok(paged.length && paged.every((b) => b.page.size === 10 && b.page.sort.direction === 'ASC'));
});

test('Petstore bindings and resource body', async () => {
  const api = await petv3Api();
  const t = petCfg().target('petstore_v3_offline');
  const b = inferBindings(api, loadResourceDefs(t.resources));
  assert.deepEqual(b.getPetById.map((x) => [...x.path]), [['petId']]);
  assert.deepEqual(b.updatePet.map((x) => [...x.path]), [['id']]);
  assert.ok(!('addPet' in b));
  const p = plan(petCfg(), api, 'petstore_v3_offline', { filters: new Filters({ tags: ['pet'] }) });
  const ops = Object.fromEntries(p.ops.map((x) => [x.op.operation_id, x]));
  assert.ok(ops.deletePet.baseline.path.petId.equals(new ResourceRef('pet', 'consume')));
  assert.ok(ops.getPetById.baseline.path.petId.equals(new ResourceRef('pet', 'read')));
  const add = ops.addPet.baseline.body;
  assert.ok(add.name.startsWith('apitest-R1'));
  assert.ok(BigInt(add.id) > 9n * 10n ** 15n);
  assert.ok(ops.updatePet.baseline.body.name.startsWith('apitest-R1'));
});

test('ownership guard', async () => {
  const p = plan(petCfg(), await petv3Api(), 'petstore_v3_offline', { level: 'full', filters: new Filters({ tags: ['pet'] }) });
  for (const x of p.ops) {
    if (x.op.method === 'GET') continue;
    const bound = new Set(x.bindings.map((b) => JSON.stringify([b.location, ...b.path])));
    for (const c of x.cases) {
      if (c.mutation.kind === 'set' && bound.has(JSON.stringify([c.mutation.field.location, ...c.mutation.field.path]))) {
        assert.ok(ownershipSafe(c.mutation.value), `${x.op.operation_id} ${c.rule_id}`);
      }
    }
  }
  assert.ok(!ownershipSafe(1.5) && !ownershipSafe(true) && !ownershipSafe(OMIT));
  assert.ok(!ownershipSafe('12') && !ownershipSafe(0) && !ownershipSafe(null));
  assert.ok(ownershipSafe('apitest') && ownershipSafe(2n ** 63n) && ownershipSafe(String(2n ** 63n)));
});

test('dry-run EPİAŞ full with exports is fast', async () => {
  const api = await epiasApi();
  const t0 = performance.now();
  const p = plan(petCfg(), api, 'epias_offline', { level: 'full', includeExports: true });
  assert.ok(performance.now() - t0 < 5000);
  assert.equal(p.ops.length, 301);
  assert.ok(p.cases.length > 10000);
});

test('levels are nested', async () => {
  const api = await petv3Api();
  const ids = Object.fromEntries(['smoke', 'standard', 'full'].map((lv) => [lv, new Set(plan(petCfg(), api, 'petstore_v3_offline', { level: lv }).cases.map((c) => c.id))]));
  const subset = (a, b) => a.size < b.size && [...a].every((x) => b.has(x));
  assert.ok(subset(ids.smoke, ids.standard) && subset(ids.standard, ids.full));
});

test('FieldRef labels', () => {
  assert.equal(new FieldRef('body', ['page', 'sort', 'direction']).label, 'body.page.sort.direction');
  assert.equal(new FieldRef('body', ['tags', 0, 'name']).label, 'body.tags[0].name');
  assert.equal(new FieldRef('query', ['status']).label, 'query.status');
});

test('create-op id is guarded (regression: addPet id 1.5 overwrote pet 1)', async () => {
  const p = plan(petCfg(), await petv3Api(), 'petstore_v3_offline', { level: 'full', filters: new Filters({ operations: ['addPet'] }) });
  const add = p.ops[0];
  const onId = add.cases.filter((c) => c.field === 'body.id');
  assert.ok(onId.length && onId.every((c) => ownershipSafe(c.mutation.value)));
  assert.ok(!onId.some((c) => ['TYPE-DECIMAL', 'TYPE-BOOL', 'REQ-OMIT', 'REQ-NULL'].includes(c.rule_id)));
  const onlyReq = add.cases.find((c) => c.rule_id === 'REQ-ONLY-REQUIRED');
  assert.ok('id' in onlyReq.mutation.value.body);
});

test('Simple API plan binds every item id', async () => {
  const api = normalize(await loadSpecSource(path.join(FIXTURES, 'apichallenges_simpleapi_openapi30.json')));
  const p = plan(cfg(), api, 'simpleapi_offline');
  const ops = Object.fromEntries(p.ops.map((x) => [x.op.operation_id, x]));
  assert.equal(Object.keys(ops).length, 12);
  assert.ok(!p.ops.some((x) => x.skip_reason));
  for (const opId of ['put_simpleapi_items_id', 'post_simpleapi_items_id', 'patch_simpleapi_items_id']) {
    const b = ops[opId].baseline;
    assert.ok(b.path.id instanceof ResourceRef && b.body.id instanceof ResourceRef);
  }
  assert.ok(ops.delete_simpleapi_items_id.baseline.path.id.equals(new ResourceRef('item', 'consume')));
  assert.match(ops.post_simpleapi_items.baseline.body.isbn13, /^[0-9]{13}$/);
});
