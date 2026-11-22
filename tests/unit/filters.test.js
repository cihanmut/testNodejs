// Operation filters: target `filters:` config, CLI flags replacing it, warnings for values that match nothing.
// Also: there is no host denylist any more, so every host is reachable through the HTTP client.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../../src/cli.js';
import { loadConfig } from '../../src/config/loader.js';
import { ConfigError } from '../../src/config/models.js';
import { SafeHttpClient } from '../../src/execution/http.js';
import { Filters } from '../../src/generators/plan.js';
import { recordingTransport } from '../fakes.js';
import { CONFIG, FIXTURES, epiasApi, petCfg, plan, runCli, tmpDir } from '../helpers.js';

/** A config dir with one target on the EPİAŞ fixture and the given `filters:` block. */
function filterCfg(filtersYaml) {
  const d = tmpDir();
  const cfgDir = path.join(d, 'config');
  fs.mkdirSync(cfgDir);
  const file = path.join(cfgDir, 'apitest.yaml');
  fs.writeFileSync(file, `defaults: { rules_file: null }
targets:
  t:
    spec: ${JSON.stringify(path.join(FIXTURES, 'epias_electricity_swagger.json'))}
    auth: { header: TGT }
    exports: { tag_pattern: "-export-controller$" }
${filtersYaml}`);
  return file;
}

test('target filters: a tag restricts the plan to that tag', async () => {
  const file = filterCfg('    filters: { tags: [consumption-data-controller] }\n');
  const c = loadConfig(file);
  assert.deepEqual(c.target('t').filters.tags, ['consumption-data-controller']);
  const p = plan(c, await epiasApi(), 't', { filters: Filters.forTarget(c.target('t')) });
  assert.ok(p.ops.length > 1);
  assert.ok(p.ops.every((o) => o.op.tags.includes('consumption-data-controller')));
  assert.deepEqual(p.filter_warnings, []);
});

test('target filters: a single path', async () => {
  const c = loadConfig(filterCfg("    filters: { paths: ['/v1/consumption/data/eligible-consumer-count'] }\n"));
  const p = plan(c, await epiasApi(), 't', { filters: Filters.forTarget(c.target('t')) });
  assert.deepEqual(p.ops.map((o) => o.op.path), ['/v1/consumption/data/eligible-consumer-count']);
});

test('target filters: unknown keys and non-lists are rejected', () => {
  assert.throws(() => loadConfig(filterCfg('    filters: { tag: [x] }\n')), ConfigError);
  assert.throws(() => loadConfig(filterCfg('    filters: { tags: { a: 1 } }\n')), ConfigError);
  assert.deepEqual(loadConfig(filterCfg('    filters: { tags: one-tag }\n')).target('t').filters.tags, ['one-tag']);
});

test('filter values that match nothing produce a warning listing the real tags', async () => {
  const api = await epiasApi();
  const w = new Filters({ tags: ['no-such-controller'], paths: ['/nope/*'] }).unmatched(api.operations);
  assert.equal(w.length, 2);
  assert.match(w[0], /tag 'no-such-controller' matches no operation\. Tags in this spec: .*consumption-data-controller/);
  assert.match(w[1], /path '\/nope\/\*' matches no operation/);
});

test('generate: target filters apply, CLI flags replace them', async () => {
  const file = filterCfg('    filters: { tags: [consumption-data-controller] }\n');
  let r = await runCli(main, ['--config', file, 'generate', '--target', 't', '--dry-run', '--level', 'smoke']);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /filters \(target 't' config\): tags=consumption-data-controller/);
  assert.ok(r.output.includes('eligible-consumer-count') && !r.output.includes('active-fullness'));

  r = await runCli(main, ['--config', file, 'generate', '--target', 't', '--dry-run', '--level', 'smoke', '--operation', 'demand-forecast']);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /filters \(command line\): operations=demand-forecast/);
  assert.match(r.output, /on 1 operations/);

  r = await runCli(main, ['--config', file, 'generate', '--target', 't', '--dry-run', '--tag', 'typo-controller']);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /warning: tag 'typo-controller' matches no operation/);
  assert.match(r.output, /no operations match the filters/);
});

test('no host denylist: requests to any host go through, safety.yaml is gone', async () => {
  const calls = [];
  const client = new SafeHttpClient({ transport: recordingTransport(calls), retries: 0 });
  const url = 'https://seffaflik.epias.com.tr/reporting-service/v1/data/x';
  assert.equal((await client.send('POST', url, null, Buffer.from('{}'))).status, 200);
  assert.deepEqual(calls, [url]);
  assert.ok(!fs.existsSync(path.join(path.dirname(CONFIG), 'safety.yaml')));
  assert.ok(!('epias' in loadConfig(CONFIG).targets));
  assert.ok('epias_offline' in petCfg().targets);
});

test('fetch-spec refuses to overwrite', async () => {
  const out = path.join(tmpDir(), 'spec.json');
  fs.writeFileSync(out, '{}');
  const r = await runCli(main, ['--config', CONFIG, 'fetch-spec', 'https://example.invalid/swagger.json', '--out', out]);
  assert.equal(r.code, 3);
  assert.match(r.output, /already exists/);
});
