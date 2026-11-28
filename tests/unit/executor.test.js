// End-to-end runs against the in-memory fake Petstore (offline): lifecycle, auth matrix, monitors, masking,
// resume, cleanup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { ResponseRecord } from '../../src/execution/http.js';
import { Filters } from '../../src/generators/plan.js';
import { loadResourceDefs } from '../../src/resources/definitions.js';
import { ResourceManager } from '../../src/resources/manager.js';
import { EXIT_ABORTED, EXIT_FAILURES, EXIT_OK, cleanupRun, executeRun } from '../../src/runner.js';
import { dumps } from '../../src/util/json.js';
import { FakePetstore, json } from '../fakes.js';
import { KEY, petCfg, fast, petv3Api, readJson, results, tmpDir } from '../helpers.js';

before(fast);

function run(fake, { level = 'standard', credential = KEY, filters = new Filters({ tags: ['pet'] }), runsDir = tmpDir(), ...kw } = {}) {
  return executeRun(petCfg(), 'petstore_v3_offline', { level, filters, credential, runsDir, transport: fake.transport(), echo: () => {}, ...kw });
}

test('full pet run cleans up everything', async () => {
  const fake = new FakePetstore({ apiKey: KEY });
  const [runDir, code] = await run(fake);
  const rs = results(runDir);
  assert.ok([EXIT_OK, EXIT_FAILURES].includes(code));
  // every baseline passed against a strict fake
  const bases = rs.filter((r) => r.case.technique === 'BASE');
  assert.equal(bases.length, 8);
  assert.ok(bases.every((r) => ['PASS', 'WARN'].includes(r.status)), JSON.stringify(bases.filter((r) => !['PASS', 'WARN'].includes(r.status)).map((r) => [r.operation.operation_id, r.reason])));
  // all pets the run created were deleted and verified gone
  assert.equal(fake.pets.size, 0);
  const runJson = readJson(path.join(runDir, 'run.json'));
  assert.deepEqual(runJson.cleanup, []);
  assert.ok(runJson.created_resources >= 2);
  // auth negatives on a server that enforces auth pass
  const auth = rs.filter((r) => r.case.technique === 'AUTH');
  assert.ok(auth.length && auth.every((r) => r.status === 'PASS'));
  // report exists and never contains the credential; neither do results or logs
  const html = fs.readFileSync(path.join(runDir, 'report.html'), 'utf8');
  for (const f of ['report.html', 'results.jsonl', 'run.log', 'run.json']) assert.ok(!fs.readFileSync(path.join(runDir, f), 'utf8').includes(KEY), f);
  assert.ok(html.includes('****6789') && html.includes('PETSTORE_API_KEY'));
  // only our own resources were ever modified: every PUT/DELETE/POST-on-item hit an id we created
  for (const req of fake.requests) {
    const segs = req.url.pathname.split('/');
    if (['PUT', 'DELETE'].includes(req.method) || (req.method === 'POST' && segs.length > 4)) {
      const seg = segs.length > 4 ? segs[4] : null;
      if (seg && /^-?\d+$/.test(seg) && BigInt(seg) >= -(2n ** 63n) && BigInt(seg) < 2n ** 63n) assert.ok(fake.ever_created.has(String(BigInt(seg))), req.url.href);
    }
  }
});

test('without a credential only the missing-credential case runs', async () => {
  delete process.env.PETSTORE_API_KEY;
  const fake = new FakePetstore({ apiKey: KEY });
  const [runDir] = await run(fake, { credential: null });
  const rs = results(runDir).filter((r) => r.operation.operation_id === 'getPetById');
  const ran = rs.filter((r) => r.status !== 'SKIPPED');
  assert.deepEqual(ran.map((r) => r.case.rule_id), ['AUTH-MISSING']);
  assert.ok(rs.filter((r) => r.status === 'SKIPPED').every((r) => r.reason.includes('no credential')));
  // the header is never sent to operations that do not need it
  assert.ok(fake.requests.filter((r) => r.url.pathname.includes('/findBy')).every((r) => r.header('api_key') === undefined));
});

test('auth gap is reported', async () => {
  const fake = new FakePetstore({ apiKey: KEY, requireAuth: false }); // like the real Petstore
  const [runDir, code] = await run(fake, { level: 'smoke' });
  const gaps = results(runDir).filter((r) => r.case.technique === 'AUTH' && r.status === 'FAIL');
  assert.ok(gaps.length && gaps.every((r) => r.reason.includes('auth gap')));
  assert.equal(code, EXIT_FAILURES);
  assert.equal(fake.pets.size, 0);
});

test('baseline failure skips the operation', async () => {
  const fake = new FakePetstore({ apiKey: KEY, failCreate: true });
  const [runDir, code] = await run(fake, { filters: new Filters({ operations: ['addPet'] }) });
  const rs = results(runDir);
  const base = rs.find((r) => r.case.technique === 'BASE');
  assert.equal(base.status, 'BASELINE_FAILED');
  assert.ok(rs.filter((r) => r !== base).every((r) => r.status === 'SKIPPED' && r.reason.includes('baseline')));
  assert.equal(code, EXIT_FAILURES);
});

test('run_after_baseline_failure: the other cases still run, each with an info note', async () => {
  const c = petCfg();
  assert.equal(c.target('petstore_v3_offline').run_after_baseline_failure, false);
  c.targets.petstore_v3_offline.run_after_baseline_failure = true;
  const fake = new FakePetstore({ apiKey: KEY, failCreate: true });
  let runDir;
  let code;
  try {
    [runDir, code] = await run(fake, { filters: new Filters({ operations: ['addPet'] }) });
  } finally {
    c.targets.petstore_v3_offline.run_after_baseline_failure = false;
  }
  const rs = results(runDir);
  const base = rs.find((r) => r.case.technique === 'BASE');
  assert.equal(base.status, 'BASELINE_FAILED');
  const others = rs.filter((r) => r !== base);
  assert.ok(others.length > 1);
  const ran = others.filter((r) => !(r.status === 'SKIPPED' && (r.reason || '').includes('baseline')));
  assert.equal(ran.length, others.length);
  assert.ok(ran.filter((r) => r.status !== 'SKIPPED').every((r) => r.findings.some((f) => f.category === 'baseline' && f.severity === 'info')));
  assert.equal(code, EXIT_FAILURES);
  assert.equal(fake.pets.size, 0);
});

test('unhealthy environment aborts', async () => {
  const c = petCfg();
  c.defaults.health_baseline_window = 3;
  let runDir;
  let code;
  try {
    [runDir, code] = await run(new FakePetstore({ apiKey: KEY, unhealthy: true }));
  } finally {
    c.defaults.health_baseline_window = 10;
  }
  assert.equal(code, EXIT_ABORTED);
  const state = readJson(path.join(runDir, 'run.json'));
  assert.ok(state.health.aborted && state.health.abort_reason.includes('unhealthy'));
  assert.ok(results(runDir).filter((r) => r.status !== 'SKIPPED').length <= 3 + 1); // stopped right after the health window
});

test('credential expiry and resume', async () => {
  const fake = new FakePetstore({ apiKey: KEY, expireAfterAuth: 3 });
  const runsDir = tmpDir();
  const [runDir, code] = await run(fake, { runsDir });
  assert.equal(code, EXIT_ABORTED);
  assert.ok(readJson(path.join(runDir, 'run.json')).health.credential_expired);
  assert.ok(results(runDir).some((r) => r.status === 'SKIPPED' && r.reason.includes('expired')));
  // resume with a "new" credential: the fake accepts it again
  fake.expire_after_auth = null;
  const [runDir2, code2] = await executeRun(petCfg(), null, { resume: path.basename(runDir), credential: KEY, runsDir, transport: fake.transport(), echo: () => {} });
  assert.equal(runDir2, runDir);
  assert.ok(!results(runDir).some((r) => r.status === 'SKIPPED' && r.reason.includes('expired')));
  assert.ok([EXIT_OK, EXIT_FAILURES].includes(code2));
  assert.equal(fake.pets.size, 0);
});

test('cleanup command deletes leftovers', async () => {
  const fake = new FakePetstore({ apiKey: KEY });
  const runsDir = tmpDir();
  const [runDir] = await run(fake, { level: 'smoke', runsDir });
  // simulate a crash that left a pet behind
  fake.pets.set('123456789012345678', { id: 123456789012345678n, name: 'apitest-x', photoUrls: [] });
  fs.appendFileSync(path.join(runDir, 'created_resources.jsonl'), dumps({ event: 'created', kind: 'pet', id: 123456789012345678n, source: 'setup' }) + '\n');
  const code = await cleanupRun(petCfg(), path.basename(runDir), { credential: KEY, runsDir, transport: fake.transport(), echo: () => {} });
  assert.equal(code, EXIT_OK);
  assert.equal(fake.pets.size, 0);
});

test("lenient server never touches someone else's pet", async () => {
  const fake = new FakePetstore({ apiKey: KEY, strict: false, coerceIds: true, requireAuth: false });
  fake.pets.set('1', { id: 1, name: "someone else's pet", photoUrls: [] });
  await run(fake, { level: 'full' });
  assert.equal(fake.pets.get('1').name, "someone else's pet");
  assert.ok(!fake.requests.some((r) => r.url.pathname.endsWith('/pet/1')));
  assert.deepEqual([...fake.pets.keys()], ['1']); // everything we created is gone
});

test('a foreign id from the response is not deleted', async () => {
  const defs = loadResourceDefs(petCfg().target('petstore_v3_offline').resources);
  const mgr = new ResourceManager(await petv3Api(), defs, null, null);
  const resp = new ResponseRecord({ status: 200, body: Buffer.from(JSON.stringify({ id: 1 })) });
  const [res, problem] = mgr.registerFromResponse('pet', resp, { body_obj: { id: 1.5 } });
  assert.equal(res, null);
  assert.ok(problem && problem.message.includes('not deleted automatically'));
  assert.deepEqual(mgr.created, []);
});

test('stale cleanup warning dropped when teardown succeeds', async () => {
  const fake = new FakePetstore({ apiKey: KEY, requireAuth: false });
  const real = fake.handle;
  let hide = 0;
  // the first GET after each DELETE still sees the pet (deleted pets "linger" once)
  fake.handle = (request) => {
    const resp = real(request);
    if (request.method === 'DELETE' && resp.status === 200) hide = 1;
    else if (request.method === 'GET' && request.url.pathname.includes('/pet/') && resp.status === 404 && hide) {
      hide -= 1;
      return json(200, { id: 1, name: 'x', photoUrls: [] });
    }
    return resp;
  };
  const [runDir] = await run(fake, { level: 'smoke' });
  assert.deepEqual(readJson(path.join(runDir, 'run.json')).cleanup, []);
  assert.equal(fake.pets.size, 0);
});
