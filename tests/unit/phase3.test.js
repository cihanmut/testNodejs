// Phase 3: form / multipart / binary bodies, file responses (exports), spec diff, injection gating.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { main } from '../../src/cli.js';
import { loadConfig } from '../../src/config/loader.js';
import { FileValue } from '../../src/data/request.js';
import { BOUNDARY, encodeBody } from '../../src/execution/encoding.js';
import { ResponseRecord } from '../../src/execution/http.js';
import { Expectation, Mutation, TestCase } from '../../src/generators/base.js';
import { Filters } from '../../src/generators/plan.js';
import { Oracle } from '../../src/oracle/oracle.js';
import { EXIT_FAILURES, executeRun, loadTargetApi, planFor, specDiff } from '../../src/runner.js';
import { diffSpecs } from '../../src/spec/diff.js';
import { LoadedSpec } from '../../src/spec/loader.js';
import { normalize } from '../../src/spec/normalize.js';
import { yamlDump } from '../../src/util/yaml.js';
import { EXPORT_SPEC, FakePetstore, exportTransport } from '../fakes.js';
import { CONFIG, KEY, ROOT, cfg, fast, petCfg, results, runCli, tmpDir } from '../helpers.js';

before(fast);

const byRule = (runDir) => Object.fromEntries(results(runDir).map((r) => [r.case.rule_id, r]));

// ------------------------------------------------------------------------------------- encodings
test('encodings', () => {
  const form = encodeBody('form', { name: 'a b', tags: ['x', 'y'], ok: true }, null);
  assert.equal(form.content.toString(), 'name=a%20b&tags=x&tags=y&ok=true');
  assert.equal(form.content_type, 'application/x-www-form-urlencoded');
  const mp = encodeBody('multipart', { meta: 'm', file: new FileValue() }, 'multipart/form-data');
  assert.equal(mp.content_type, `multipart/form-data; boundary=${BOUNDARY}`);
  assert.ok(mp.content.includes(Buffer.from('name="file"; filename="apitest.png"')) && mp.content.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
  assert.ok(mp.content.toString('latin1').endsWith(`--${BOUNDARY}--\r\n`));
  assert.ok(mp.display.includes('file=<file apitest.png'));
  const binary = encodeBody('binary', new FileValue(), 'application/octet-stream');
  assert.ok(binary.content.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
  assert.equal(binary.content_type, 'application/octet-stream');
});

test('baselines pick the right encoding', async () => {
  for (const [target, opId, enc] of [['petstore_v2_offline', 'uploadFile', 'multipart'], ['petstore_v2_offline', 'updatePetWithForm', 'form'],
    ['petstore_v3_offline', 'uploadFile', 'binary'], ['petstore_v3_offline', 'addPet', 'json']]) { // JSON preferred when offered
    const t = petCfg().target(target);
    const [api] = await loadTargetApi(petCfg(), t, null);
    const [p] = planFor(petCfg(), t, api, { level: 'standard', runId: 'R1', filters: new Filters({ operations: [opId] }), includeExports: false });
    assert.equal(p.ops[0].baseline.encoding, enc, `${target} ${opId}`);
    assert.equal(p.ops[0].skip_reason, null);
  }
});

test('v3 binary upload runs', async () => {
  const fake = new FakePetstore({ apiKey: KEY });
  const [runDir] = await executeRun(petCfg(), 'petstore_v3_offline', {
    level: 'standard', filters: new Filters({ operations: ['uploadFile'] }), credential: KEY, runsDir: tmpDir(), transport: fake.transport(), echo: () => {},
  });
  const r = byRule(runDir);
  assert.equal(r.BASELINE.status, 'PASS', r.BASELINE.reason);
  assert.equal(r['E-EMPTY-UPLOAD'].status, 'PASS'); // empty upload rejected by the fake
  assert.ok(fake.uploads.length && fake.uploads[0][0] === 'application/octet-stream');
  assert.ok(fs.readFileSync(path.join(runDir, 'apitest.png')).subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))); // file referenced by curl
  assert.ok(r.BASELINE.curl_bash.includes("--data-binary '@apitest.png'"));
  assert.equal(fake.pets.size, 0);
});

test('v2 form and multipart run', async () => {
  const fake = new FakePetstore({ apiKey: KEY, prefix: '/v2' });
  const [runDir] = await executeRun(petCfg(), 'petstore_v2_offline', {
    level: 'standard', filters: new Filters({ operations: ['uploadFile', 'updatePetWithForm'] }), credential: KEY, runsDir: tmpDir(), transport: fake.transport(), echo: () => {},
  });
  const bases = Object.fromEntries(results(runDir).filter((r) => r.case.technique === 'BASE').map((r) => [r.operation.operation_id, r]));
  assert.ok(Object.values(bases).every((b) => ['PASS', 'WARN'].includes(b.status)), JSON.stringify(Object.fromEntries(Object.entries(bases).map(([k, v]) => [k, v.reason]))));
  assert.ok(fake.uploads.length && fake.uploads[0][0] === 'multipart/form-data');
  const form = bases.updatePetWithForm;
  assert.equal(form.request.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.ok(form.request.body.startsWith('name=apitest-'));
  assert.ok(bases.uploadFile.curl_bash.includes("-F 'file=@apitest.png;type=image/png'"));
  assert.equal(fake.pets.size, 0);
});

// ------------------------------------------------------------------------------------- exports
function exportCfg() {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, 'config'));
  const spec = path.join(d, 'export_spec.json');
  fs.writeFileSync(spec, JSON.stringify(EXPORT_SPEC));
  fs.writeFileSync(path.join(d, 'config', 'apitest.yaml'), yamlDump({
    defaults: { rules_file: null },
    profiles: { 'company-test': { rate_limit_rps: 100, own_resources_only: true, allow_injection: true } },
    targets: { exports: { spec, profile: 'company-test', exports: { tag_pattern: '-export-controller$', type_field: 'exportType' } } },
  }));
  return [loadConfig(path.join(d, 'config', 'apitest.yaml')), d];
}

test('export files are checked', async () => {
  const [c, d] = exportCfg();
  const [runDir, code] = await executeRun(c, 'exports', { level: 'standard', includeExports: true, runsDir: path.join(d, 'runs'), transport: exportTransport, echo: () => {} });
  const rs = Object.fromEntries(results(runDir).map((r) => [`${r.operation.operation_id}|${r.case.rule_id}`, r]));
  assert.equal(rs['report-export|BASELINE'].status, 'PASS'); // XLSX (first enum value)
  assert.equal(rs['report-export|EXPORT-CSV'].status, 'PASS');
  assert.equal(rs['report-export|EXPORT-PDF'].status, 'PASS');
  const broken = rs['broken-export|EXPORT-PDF'];
  assert.equal(broken.status, 'FAIL');
  assert.match(broken.reason, /JSON instead of a file/);
  assert.equal(code, EXIT_FAILURES);
});

test('export operations are excluded by default', async () => {
  const [c] = exportCfg();
  const t = c.target('exports');
  const [api] = await loadTargetApi(c, t, null);
  const [p] = planFor(c, t, api, { level: 'standard', runId: 'R', filters: new Filters(), includeExports: false });
  assert.deepEqual(p.ops, []);
  assert.equal(p.excluded_exports, 2);
});

test('wrong file signature fails', () => {
  const api = normalize(new LoadedSpec(EXPORT_SPEC, '{}', 'x', null, 'x'), '-export-controller$');
  const op = api.operation('report-export');
  const c = new TestCase({ id: 'TC-x', target: 't', operation_id: 'report-export', technique: 'BASE', group: 'baseline', field: null, rule_id: 'BASELINE', title: 't', mutation: new Mutation('none'), expectation: new Expectation('accept'), level: 'smoke', needs_auth: false });
  const oracle = new Oracle(null, 3000, null, null, { type_field: 'exportType', tag_pattern: null });
  const fakePdf = new ResponseRecord({ status: 200, headers: { 'content-type': 'application/pdf' }, body: Buffer.from('<html>error</html>') });
  const v = oracle.evaluate(c, op, fakePdf, { exportType: 'PDF' });
  assert.equal(v.status, 'FAIL');
  assert.match(v.reason, /not a PDF file/);
  const xlsxNamedCsv = new ResponseRecord({ status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': 'attachment; filename="report.csv"' }, body: Buffer.from('PK\x03\x04xx', 'latin1') });
  assert.match(oracle.evaluate(c, op, xlsxNamedCsv, { exportType: 'XLSX' }).reason, /file name is report\.csv/);
});

// ------------------------------------------------------------------------------------- spec diff
function spec({ paramsRequired = false, statusEnum = ['a', 'b'], priceType = 'number', extraOp = false, dropOp = false } = {}) {
  const paths = {
    '/items': {
      get: { operationId: 'list', parameters: [{ name: 'status', in: 'query', required: paramsRequired, schema: { type: 'string', enum: statusEnum } }], responses: { 200: { description: 'ok' } } },
      post: { operationId: 'create', description: "text changes don't matter " + extraOp, requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } }, responses: { 201: { description: 'ok' } } },
    },
  };
  if (!dropOp) paths['/items/{id}'] = { delete: { operationId: 'remove', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 204: { description: 'gone' } } } };
  if (extraOp) paths['/items/search'] = { get: { operationId: 'search', responses: { 200: { description: 'ok' } } } };
  const raw = { openapi: '3.0.0', info: { title: 't', version: '1' }, paths, components: { schemas: { Item: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 50 }, price: { type: priceType } } } } } };
  return normalize(new LoadedSpec(raw, JSON.stringify(raw), 'inline', null, 'x'));
}

test('spec diff is field-level', () => {
  const old = spec();
  const d = diffSpecs(old, spec({ paramsRequired: true, statusEnum: ['a', 'b', 'c'], priceType: 'string', extraOp: true, dropOp: true }));
  assert.deepEqual(d.added, ['GET /items/search (search)']);
  assert.deepEqual(d.removed, ['DELETE /items/{id} (remove)']);
  assert.deepEqual(new Set(Object.keys(d.changed)), new Set(['GET /items', 'POST /items'])); // description change alone is ignored
  const getChanges = d.changed['GET /items'].join(' ');
  assert.ok(getChanges.includes('required False → True') && getChanges.includes('enum'));
  assert.ok(d.changed['POST /items'].some((c) => c.includes('body.price') && c.includes('type number → string')));
  assert.deepEqual(new Set(d.keys_to_test), new Set(['GET /items/search', 'GET /items', 'POST /items']));
  assert.deepEqual(diffSpecs(old, spec()).changed, {});
});

test('changed-since via the CLI', async () => {
  const d = tmpDir();
  const oldFile = path.join(d, 'old.json');
  const newFile = path.join(d, 'new.json');
  const v3 = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/petstore_v3_openapi.json'), 'utf8'));
  fs.writeFileSync(oldFile, JSON.stringify(v3));
  v3.components.schemas.Pet.properties.name.maxLength = 30; // one schema change
  delete v3.paths['/pet/findByTags']; // one removed op
  fs.writeFileSync(newFile, JSON.stringify(v3));
  const r = await runCli(main, ['--config', CONFIG, 'diff', oldFile, newFile]);
  assert.equal(r.code, 0, r.output);
  assert.ok(r.output.includes('removed 1') && r.output.includes('~ POST /pet') && r.output.includes('maxLength — → 30'), r.output);
  // only the operations using Pet are re-tested
  const diff = await specDiff(loadConfig(CONFIG), oldFile, newFile);
  assert.ok(diff.keys_to_test.includes('PUT /pet') && diff.keys_to_test.includes('POST /pet') && !diff.keys_to_test.includes('GET /store/inventory'));
});

// ------------------------------------------------------------------------------------- injection
test('injection is refused on public-demo', async () => {
  const r = await runCli(main, ['--config', CONFIG, 'generate', '--target', 'simpleapi_offline', '--dry-run', '--allow-injection']);
  assert.equal(r.code, 3);
  assert.match(r.output, /refused/);
});

test('injection only with flag and profile', async () => {
  const [c] = exportCfg();
  const t = c.target('exports');
  const [api] = await loadTargetApi(c, t, null);
  const [off] = planFor(c, t, api, { level: 'full', runId: 'R', filters: new Filters(), includeExports: true });
  const [on] = planFor(c, t, api, { level: 'full', runId: 'R', filters: new Filters(), includeExports: true, allowInjection: true });
  assert.ok(!off.cases.some((x) => x.technique === 'E-injection'));
  const inj = on.cases.filter((x) => x.technique === 'E-injection');
  assert.ok(inj.length && inj.every((x) => x.expectation.kind === 'no_5xx'));
  // public-demo: even with the flag passed programmatically, nothing is generated
  const pc = loadConfig(CONFIG);
  const tp = pc.target('simpleapi_offline');
  const [api2] = await loadTargetApi(pc, tp, null);
  const [demo] = planFor(pc, tp, api2, { level: 'full', runId: 'R', filters: new Filters(), includeExports: false, allowInjection: true });
  assert.ok(!demo.cases.some((x) => x.technique === 'E-injection'));
});
