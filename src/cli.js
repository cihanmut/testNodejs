#!/usr/bin/env node
// apitest command line.
//
//   apitest fetch-spec <url|editor-link> --out FILE    the ONLY way to download a spec from a denylisted host
//   apitest analyze  --target T | --spec SRC           Step-0 style spec analysis
//   apitest generate --target T --dry-run [filters]    list generated cases, send nothing
//   apitest run      --target T [--level] [filters]    execute; writes runs/<target>/<runId>/
//   apitest run      --resume RUNID                    continue a run (e.g. with a new credential)
//   apitest report   --run RUNID                       re-render the report files
//   apitest cleanup  --run RUNID                       retry deleting resources a run left behind
//   apitest diff     OLD NEW                           what changed between two spec versions
//
// Exit codes: 0 ok · 1 failures/cleanup problems · 2 aborted/credential expired · 3 usage/config · 4 denylist
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config/loader.js';
import { ConfigError, LEVELS } from './config/models.js';
import { DeniedHostError } from './config/safety.js';
import { Filters } from './generators/plan.js';
import { ResourceConfigError } from './resources/definitions.js';
import { RuleError } from './generators/rules.js';
import {
  EXIT_DENIED, EXIT_OK, EXIT_USAGE, RunError, changedSince, cleanupRun, executeRun, loadTargetApi, makeHttp, planFor, renderReport, specDiff,
  writeCasesCsv,
} from './runner.js';
import { analyze as analyzeSpec, formatAnalysis } from './spec/analyze.js';
import { SpecLoadError, loadSpecSource, resolveEditorLink } from './spec/loader.js';
import { normalize } from './spec/normalize.js';
import { dumps } from './util/json.js';
import { Counter } from './util/py.js';

/** An error with an exit code (click.ClickException look-alike: printed as "Error: <message>"). */
export class CliExit extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

class UsageError extends CliExit {
  constructor(message) {
    super(message, 2);
  }
}

// ------------------------------------------------------------------------------------- arg parsing
const FILTER_OPTS = {
  tag: { kind: 'multi', help: 'tag (repeatable)' },
  path: { kind: 'multi', help: "path glob, e.g. '/pet/*' (repeatable)" },
  method: { kind: 'multi', help: 'HTTP method (repeatable)' },
  operation: { kind: 'multi', help: 'operationId glob (repeatable)' },
  'allow-injection': { kind: 'flag', help: "add SQL/script injection strings (only if the target's profile allows it; never public demo servers)" },
  'changed-since': { kind: 'value', help: 'only operations new/changed since this spec (file, URL or run id)' },
};

const COMMANDS = {
  'fetch-spec': {
    help: 'Download a spec ONCE (allowed even for denylisted hosts). Refuses to overwrite an existing file.',
    args: ['SOURCE'],
    opts: { out: { kind: 'value', required: true, help: 'file to save the spec to' } },
  },
  analyze: {
    help: 'Analyze a spec: counts, auth, constraints, responses, documentation findings.',
    opts: {
      target: { kind: 'value', help: 'target name from config' },
      spec: { kind: 'value', help: 'spec file / URL / editor link (instead of a target)' },
      json: { kind: 'value', help: 'also write the analysis as JSON' },
    },
  },
  generate: {
    help: 'Generate test cases and show counts per operation and technique. Sends nothing.',
    opts: {
      target: { kind: 'value', required: true, help: 'target name from config' },
      'dry-run': { kind: 'flag', help: 'list cases only (generate never sends requests)' },
      level: { kind: 'value', choices: LEVELS, help: 'smoke | standard | full' },
      'include-exports': { kind: 'flag', help: 'include file-export operations' },
      csv: { kind: 'value', help: 'write all cases to a CSV file' },
      'per-operation': { kind: 'flag', default: true, negatable: true, help: 'print the per-operation table (--no-per-operation to hide it)' },
      ...FILTER_OPTS,
    },
  },
  run: {
    help: 'Execute tests against a target and write the run folder + reports.',
    opts: {
      target: { kind: 'value', help: 'target name from config' },
      level: { kind: 'value', choices: LEVELS, help: 'smoke | standard | full' },
      'include-exports': { kind: 'flag', default: null, help: 'include file-export operations' },
      credential: { kind: 'value', help: 'credential value (prefer --credential-env; shells keep history)' },
      'credential-env': { kind: 'value', help: 'name of the env var holding the credential' },
      resume: { kind: 'value', help: 'run id (or run folder) to continue' },
      ...FILTER_OPTS,
    },
  },
  diff: {
    help: 'Compare two spec versions (file, URL, editor link or run id). Lists added, removed and changed operations with field-level changes. Test only those with `run --changed-since OLD`.',
    args: ['OLD', 'NEW'],
    opts: { json: { kind: 'value', help: 'also write the diff as JSON' } },
  },
  report: {
    help: 'Re-render the report files of a run (HTML, JUnit XML, CSV, Excel) from its results.',
    opts: {
      run: { kind: 'value', required: true, help: 'run id or run folder' },
      format: { kind: 'value', help: 'comma-separated: html,junit,csv,xlsx (default from config: all)' },
    },
  },
  cleanup: {
    help: 'Retry deleting resources that a run could not clean up.',
    opts: {
      run: { kind: 'value', required: true, help: 'run id or run folder' },
      credential: { kind: 'value', help: 'credential value' },
      'credential-env': { kind: 'value', help: 'name of the env var holding the credential' },
    },
  },
};

const MAIN_HELP = `Usage: apitest [--config FILE] COMMAND [OPTIONS]

  Swagger/OpenAPI-driven REST API test tool.

Options:
  --config FILE  main config file (safety.yaml is read next to it)  [default: config/apitest.yaml]
  -h, --help     Show this message and exit.

Commands:
${Object.entries(COMMANDS).map(([n, c]) => `  ${n.padEnd(11)}${c.help.split('. ')[0].replace(/\.$/, '')}`).join('\n')}

Exit codes: 0 ok · 1 failures/cleanup problems · 2 aborted/credential expired · 3 usage/config · 4 denylist`;

function commandHelp(name) {
  const c = COMMANDS[name];
  const lines = [`Usage: apitest ${name} ${(c.args || []).join(' ')} [OPTIONS]`.replace(/ {2}/g, ' '), '', `  ${c.help}`, '', 'Options:'];
  for (const [opt, spec] of Object.entries(c.opts)) {
    let flag = `--${opt}`;
    if (spec.negatable) flag = `--${opt} / --no-${opt}`;
    else if (spec.kind !== 'flag') flag += spec.choices ? ` [${spec.choices.join('|')}]` : ' TEXT';
    lines.push(`  ${flag.padEnd(36)}${spec.help || ''}${spec.required ? '  [required]' : ''}`);
  }
  lines.push(`  ${'-h, --help'.padEnd(36)}Show this message and exit.`);
  return lines.join('\n');
}

export function parseArgs(argv) {
  const global = { config: 'config/apitest.yaml' };
  let i = 0;
  while (i < argv.length && argv[i].startsWith('-')) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '--config') {
      if (i + 1 >= argv.length) throw new UsageError("Option '--config' requires an argument.");
      global.config = argv[i + 1];
      i += 2;
    } else if (a.startsWith('--config=')) {
      global.config = a.slice(9);
      i += 1;
    } else {
      throw new UsageError(`No such option: ${a}`);
    }
  }
  if (i >= argv.length) return { help: true };
  const name = argv[i++];
  const spec = COMMANDS[name];
  if (!spec) throw new UsageError(`No such command '${name}'.`);
  const opts = {};
  for (const [k, s] of Object.entries(spec.opts)) {
    if (s.kind === 'multi') opts[k] = [];
    else if (s.kind === 'flag') opts[k] = s.default !== undefined ? s.default : false;
    else opts[k] = null;
  }
  const args = [];
  while (i < argv.length) {
    let a = argv[i++];
    if (a === '-h' || a === '--help') return { help: true, command: name };
    if (!a.startsWith('--') || a === '--') {
      args.push(a);
      continue;
    }
    let value = null;
    const eq = a.indexOf('=');
    if (eq > 0) {
      value = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    let key = a.slice(2);
    let negated = false;
    if (!(key in spec.opts) && key.startsWith('no-') && spec.opts[key.slice(3)] && spec.opts[key.slice(3)].negatable) {
      key = key.slice(3);
      negated = true;
    }
    const s = spec.opts[key];
    if (!s) throw new UsageError(`No such option: ${a}`);
    if (s.kind === 'flag') {
      if (value !== null) throw new UsageError(`Option '${a}' does not take a value.`);
      opts[key] = !negated;
      continue;
    }
    if (value === null) {
      if (i >= argv.length) throw new UsageError(`Option '${a}' requires an argument.`);
      value = argv[i++];
    }
    if (s.choices && !s.choices.includes(value)) throw new UsageError(`Invalid value for '${a}': '${value}' is not one of ${s.choices.map((x) => `'${x}'`).join(', ')}.`);
    if (s.kind === 'multi') opts[key].push(value);
    else opts[key] = value;
  }
  for (const [k, s] of Object.entries(spec.opts)) if (s.required && (opts[k] === null || opts[k] === undefined)) throw new UsageError(`Missing option '--${k}'.`);
  const want = spec.args || [];
  if (args.length < want.length) throw new UsageError(`Missing argument '${want[args.length]}'.`);
  if (args.length > want.length) throw new UsageError(`Got unexpected extra argument (${args.slice(want.length).join(' ')})`);
  return { command: name, global, opts, args };
}

// ------------------------------------------------------------------------------------- helpers
function cfgOf(global) {
  try {
    return loadConfig(global.config);
  } catch (exc) {
    if (exc instanceof ConfigError || exc.name === 'YAMLException') throw new CliExit(exc.message, 1);
    throw exc;
  }
}

function targetOf(cfg, name) {
  try {
    return cfg.target(name);
  } catch (exc) {
    throw new CliExit(exc.message, EXIT_USAGE);
  }
}

const filtersOf = (o) => new Filters({ tags: o.tag, paths: o.path, methods: o.method, operations: o.operation });

function injectionAllowed(cfg, tcfg, flag) {
  if (!flag) return false;
  const prof = cfg.profileFor(tcfg);
  if (!prof.allow_injection) {
    throw new CliExit(`--allow-injection refused: profile '${prof.name}' does not allow injection strings `
      + '(never on public demo servers; enable allow_injection only in your own test profile)', EXIT_USAGE);
  }
  return true;
}

/** --changed-since: restrict to operations that are new or changed compared to an older spec. Returns
 *  [filters, stop] where stop=true means there is nothing to test. */
async function changedFilter(cfg, tcfg, since, flt, out) {
  if (!since) return [flt, false];
  let d;
  try {
    d = await changedSince(cfg, tcfg, since);
  } catch (exc) {
    if (exc instanceof RunError || exc instanceof SpecLoadError || exc instanceof DeniedHostError) throw new CliExit(exc.message, EXIT_USAGE);
    throw exc;
  }
  out(`changed since ${since}: added ${d.added.length}, changed ${Object.keys(d.changed).length}, removed ${d.removed.length}, unchanged ${d.unchanged}`);
  if (!d.keys_to_test.length) {
    out('no new or changed operations: nothing to test');
    return [flt, true];
  }
  flt = flt || new Filters();
  flt.op_keys = d.keys_to_test;
  return [flt, false];
}

// ------------------------------------------------------------------------------------- commands
async function cmdFetchSpec(cfg, { opts, args }, out) {
  const outPath = opts.out;
  if (fs.existsSync(outPath)) {
    throw new CliExit(`${outPath} already exists; specs from denylisted hosts are downloaded only once. `
      + 'Delete the file yourself if you really want a fresh copy.', EXIT_USAGE);
  }
  const url = resolveEditorLink(args[0]);
  const denied = cfg.denylist.isDenied(url);
  const http = makeHttp(cfg, null, { allowOnceUrl: denied ? url : null });
  let loaded;
  try {
    loaded = await loadSpecSource(url, http);
  } catch (exc) {
    if (exc instanceof SpecLoadError || exc instanceof DeniedHostError) throw new CliExit(exc.message, EXIT_USAGE);
    throw exc;
  } finally {
    http.close();
  }
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, loaded.text, 'utf8');
  const note = denied ? ' (denylisted host: this was the single allowed request)' : '';
  out(`saved ${outPath} (${loaded.text.length} bytes, sha256 ${loaded.sha256.slice(0, 16)}…)${note}`);
  return EXIT_OK;
}

async function cmdAnalyze(cfg, { opts }, out) {
  if (!opts.target && !opts.spec) throw new UsageError('give --target or --spec');
  const tcfg = opts.target ? targetOf(cfg, opts.target) : null;
  const http = makeHttp(cfg);
  let api;
  try {
    if (tcfg) [api] = await loadTargetApi(cfg, tcfg, http, opts.spec);
    else api = normalize(await loadSpecSource(opts.spec, http));
  } catch (exc) {
    if (exc instanceof SpecLoadError || exc instanceof DeniedHostError) throw new CliExit(exc.message, exc instanceof DeniedHostError ? EXIT_DENIED : EXIT_USAGE);
    throw exc;
  } finally {
    http.close();
  }
  const result = analyzeSpec(api, tcfg ? tcfg.auth : null);
  out(formatAnalysis(result));
  if (opts.json) {
    fs.writeFileSync(opts.json, dumps(result, { indent: 2 }), 'utf8');
    out(`\nwritten ${opts.json}`);
  }
  return EXIT_OK;
}

async function cmdGenerate(cfg, { opts }, out) {
  const tcfg = targetOf(cfg, opts.target);
  const injection = injectionAllowed(cfg, tcfg, opts['allow-injection']);
  const [flt, stop] = await changedFilter(cfg, tcfg, opts['changed-since'], filtersOf(opts), out);
  if (stop) return EXIT_OK;
  const level = opts.level || cfg.defaults.level;
  const t0 = performance.now();
  const http = makeHttp(cfg);
  let api;
  try {
    [api] = await loadTargetApi(cfg, tcfg, http);
  } catch (exc) {
    if (exc instanceof SpecLoadError || exc instanceof DeniedHostError) throw new CliExit(exc.message, EXIT_USAGE);
    throw exc;
  } finally {
    http.close();
  }
  let plan;
  try {
    [plan] = planFor(cfg, tcfg, api, { level, runId: 'DRYRUN', filters: flt, includeExports: opts['include-exports'] || cfg.defaults.include_exports, allowInjection: injection });
  } catch (exc) {
    if (exc instanceof RunError) throw new CliExit(exc.message, exc.code);
    throw exc;
  }
  const elapsed = (performance.now() - t0) / 1000;
  const rank = (t) => (t === 'BASE' ? 0 : t === 'AUTH' ? 1 : 9);
  const techniques = [...new Set(plan.cases.map((c) => c.technique))].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  if (opts['per-operation']) {
    const width = Math.max(...plan.ops.map((p) => p.op.operation_id.length), 10);
    const head = `${'operation'.padEnd(width)}  ${'method'.padEnd(6)} auth ` + techniques.map((t) => t.padStart(11)).join(' ') + ` ${'total'.padStart(6)}`;
    out(head);
    out('-'.repeat(head.length));
    for (const p of plan.ops) {
      const cnt = Counter.of(p.cases.map((c) => c.technique));
      const note = p.skip_reason ? `  (${p.skip_reason})` : '';
      out(`${p.op.operation_id.padEnd(width)}  ${p.op.method.padEnd(6)} ${p.auth.needs ? 'yes ' : 'no  '}`
        + techniques.map((t) => String(cnt.getn(t)).padStart(11)).join(' ') + ` ${String(p.cases.length).padStart(6)}${note}`);
    }
    out('-'.repeat(head.length));
  }
  const totals = plan.countsByTechnique();
  out(`level ${level}: ${plan.cases.length} cases on ${plan.ops.length} operations  (` + techniques.map((t) => `${t} ${totals.getn(t)}`).join(', ') + ')');
  if (plan.excluded_exports) out(`excluded ${plan.excluded_exports} export operation(s) (use --include-exports)`);
  if (plan.findings.length) {
    const kinds = Counter.of(plan.findings.map((f) => f.kind));
    out('documentation findings while generating: ' + [...kinds].map(([k, v]) => `${k} ${v}`).join(', '));
  }
  const denied = cfg.denylist.isDenied(tcfg.spec) || api.servers.some((s) => cfg.denylist.isDenied(s));
  if (denied) out('target host is denylisted: dry-run only, `apitest run` is blocked');
  out(`generated in ${elapsed.toFixed(2)}s — nothing was sent`);
  if (opts.csv) {
    writeCasesCsv(plan, opts.csv);
    out(`written ${opts.csv}`);
  }
  return EXIT_OK;
}

async function cmdRun(cfg, { opts }, out, err) {
  let flt = ['tag', 'path', 'method', 'operation'].some((k) => opts[k].length) ? filtersOf(opts) : null;
  let injection = false;
  if (opts.target && !opts.resume) {
    const tcfg = targetOf(cfg, opts.target);
    injection = injectionAllowed(cfg, tcfg, opts['allow-injection']);
    let stop;
    [flt, stop] = await changedFilter(cfg, tcfg, opts['changed-since'], flt, out);
    if (stop) return EXIT_OK;
  }
  let n = 0;
  const progress = () => {
    n += 1;
    if (n % 25 === 0) err(`  … ${n} cases executed`);
  };
  try {
    const [, code] = await executeRun(cfg, opts.target, {
      level: opts.level, filters: flt, includeExports: opts['include-exports'], credential: opts.credential, credentialEnv: opts['credential-env'],
      resume: opts.resume, echo: out, progress, allowInjection: injection,
    });
    return code;
  } catch (exc) {
    if (exc instanceof RunError) throw new CliExit(exc.message, exc.code);
    if (exc instanceof SpecLoadError || exc instanceof ConfigError || exc instanceof ResourceConfigError || exc instanceof RuleError) throw new CliExit(exc.message, EXIT_USAGE);
    throw exc;
  }
}

async function cmdDiff(cfg, { opts, args }, out) {
  let d;
  try {
    d = await specDiff(cfg, args[0], args[1]);
  } catch (exc) {
    if (exc instanceof RunError || exc instanceof SpecLoadError || exc instanceof DeniedHostError) throw new CliExit(exc.message, EXIT_USAGE);
    throw exc;
  }
  out(d.format());
  if (opts.json) {
    fs.writeFileSync(opts.json, dumps(d.toDict(), { indent: 2 }), 'utf8');
    out(`written ${opts.json}`);
  }
  return EXIT_OK;
}

async function cmdReport(cfg, { opts }, out) {
  const wanted = opts.format ? opts.format.split(',').map((f) => f.trim()) : null;
  const bad = (wanted || []).filter((f) => !['html', 'junit', 'csv', 'xlsx'].includes(f));
  if (bad.length) throw new UsageError(`unknown format(s): ${bad.join(', ')}`);
  try {
    for (const p of renderReport(cfg, opts.run, null, wanted)) out(`written ${p}`);
  } catch (exc) {
    if (exc instanceof RunError) throw new CliExit(exc.message, exc.code);
    throw exc;
  }
  return EXIT_OK;
}

async function cmdCleanup(cfg, { opts }, out) {
  try {
    return await cleanupRun(cfg, opts.run, { credential: opts.credential, credentialEnv: opts['credential-env'], echo: out });
  } catch (exc) {
    if (exc instanceof RunError) throw new CliExit(exc.message, exc.code);
    throw exc;
  }
}

const HANDLERS = { 'fetch-spec': cmdFetchSpec, analyze: cmdAnalyze, generate: cmdGenerate, run: cmdRun, diff: cmdDiff, report: cmdReport, cleanup: cmdCleanup };

/** Run the CLI. Returns the exit code; output goes through out/err (console by default). */
export async function main(argv, { out = (s) => process.stdout.write(s + '\n'), err = (s) => process.stderr.write(s + '\n') } = {}) {
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      out(parsed.command ? commandHelp(parsed.command) : MAIN_HELP);
      return EXIT_OK;
    }
    const cfg = cfgOf(parsed.global);
    return await HANDLERS[parsed.command](cfg, parsed, out, err);
  } catch (exc) {
    if (exc instanceof UsageError) {
      err('Usage: apitest [--config FILE] COMMAND [OPTIONS]\nTry \'apitest --help\' for help.\n');
      err(`Error: ${exc.message}`);
      return exc.code;
    }
    if (exc instanceof CliExit) {
      err(`Error: ${exc.message}`);
      return exc.code;
    }
    throw exc;
  }
}

// Started directly (node src/cli.js ...): run and exit with the command's code.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) {
    process.stderr.write(`apitest needs Node.js 18 or newer (found ${process.versions.node})\n`);
    process.exit(EXIT_USAGE);
  }
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (exc) => {
    process.stderr.write(`${exc && exc.stack ? exc.stack : exc}\n`);
    process.exitCode = 1;
  });
}
