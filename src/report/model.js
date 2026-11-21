// Turn a run directory (run.json + results.jsonl) into report data. `apitest report --run` re-renders from
// these files, so reports never need the network or the original process.
import fs from 'node:fs';
import path from 'node:path';
import { BASELINE_FAILED, CaseResult, ERROR, FAIL, FAILING, KNOWN, PASS, SKIPPED, STATUSES, WARN } from '../results.js';
import { parseJson } from '../util/json.js';
import { Counter, pyRepr, sorted } from '../util/py.js';

const UNDOC_MIN_OPS = 2; // same undocumented code on >= N operations -> one documentation finding

export function loadResults(runDir) {
  const latest = new Map();
  const file = path.join(runDir, 'results.jsonl');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const r = CaseResult.fromDict(parseJson(line));
      latest.set(r.case.id, r);
    }
  }
  return [...latest.values()];
}

export function ticketText(r) {
  const c = r.case;
  const actual = r.response && r.response.status !== null ? `HTTP ${r.response.status}` : 'no response';
  const body = (r.response && r.response.body ? r.response.body.slice(0, 1200) : '').trim();
  const codes = c.expect_codes && c.expect_codes.length ? pyRepr(c.expect_codes) : '';
  const exp = {
    accept: '2xx with a body matching the documented schema',
    reject: '4xx ' + codes,
    auth_reject: 'rejected as unauthenticated ' + codes,
    no_5xx: 'no server error',
  }[c.expect] ?? c.expect;
  const lines = [
    `[${r.operation.operation_id}] ${c.field || ''} ${c.rule_id}: ${r.reason}`.replace(/ {2}/g, ' '),
    '',
    `Endpoint: ${r.operation.method} ${r.operation.path}`,
    `Test case: ${c.id} (${c.technique}, rule ${c.rule_id}) - ${c.title}`,
    '',
    'Steps to reproduce:',
    r.curl_bash || '(no request sent)',
    '',
    `Expected: ${exp}`,
    `Actual: ${actual}` + (r.reason ? ` — ${r.reason}` : ''),
  ];
  if (body) lines.push('', 'Response body (excerpt):', body);
  return lines.join('\n');
}

const zeroCounts = (c) => Object.fromEntries(STATUSES.map((s) => [s, c ? c.getn(s) : 0]));

export function buildReportData(runDir) {
  const run = parseJson(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  const results = loadResults(runDir);
  const order = Object.fromEntries(STATUSES.map((s, i) => [s, i]));
  const sortedResults = sorted(results, (r) => [order[r.status] ?? 99, r.operation.operation_id, r.case.technique, r.case.id]);

  const counts = Counter.of(sortedResults.map((r) => r.status));
  const byTag = new Map();
  const byTech = new Map();
  const byOp = new Map();
  const opInfo = new Map();
  const bump = (m, k, s) => {
    if (!m.has(k)) m.set(k, new Counter());
    m.get(k).add(s);
  };
  for (const r of sortedResults) {
    for (const tag of r.operation.tags && r.operation.tags.length ? r.operation.tags : ['<untagged>']) bump(byTag, tag, r.status);
    bump(byTech, r.case.technique, r.status);
    bump(byOp, r.operation.operation_id, r.status);
    opInfo.set(r.operation.operation_id, r.operation);
  }

  const defects = sortedResults.filter((r) => FAILING.has(r.status) && r.case.group !== 'auth');
  const auth = sortedResults.filter((r) => r.case.group === 'auth' && [FAIL, WARN, KNOWN, ERROR].includes(r.status));
  const noCred = Counter.of(sortedResults.filter((r) => r.status === SKIPPED && r.reason.startsWith('no credential')).map((r) => r.operation.operation_id));
  const warnings = sortedResults.filter((r) => r.status === WARN && r.case.group !== 'auth');
  const known = sortedResults.filter((r) => r.status === KNOWN);

  const undoc = new Map();
  for (const r of sortedResults) {
    for (const f of r.findings) {
      if (f.category === 'documentation' && f.message.startsWith('status ')) {
        const code = f.message.split(/\s+/)[1];
        if (!undoc.has(code)) undoc.set(code, new Set());
        undoc.get(code).add(r.operation.operation_id);
      }
    }
  }
  const docFindings = [];
  for (const [code, ops] of sorted([...undoc.entries()], (e) => e[0])) {
    const list = sorted([...ops]);
    docFindings.push({
      kind: 'undocumented_status',
      message: ops.size >= UNDOC_MIN_OPS ? `status ${code} returned but not documented by ${ops.size} operations` : `status ${code} returned but not documented`,
      operations: list,
    });
  }
  docFindings.push(...(run.spec_findings || []));

  const failing = [...FAILING].reduce((n, s) => n + counts.getn(s), 0);
  const tickets = {};
  for (const r of sortedResults) if ([FAIL, BASELINE_FAILED, ERROR, WARN, KNOWN].includes(r.status)) tickets[r.case.id] = ticketText(r);
  return {
    meta: run.meta,
    health: run.health || {},
    cleanup: run.cleanup || [],
    created_resources: run.created_resources || 0,
    counts: zeroCounts(counts),
    total: sortedResults.length,
    failing,
    matrix_tag: Object.fromEntries(sorted([...byTag.entries()], (e) => e[0]).map(([t, c]) => [t, zeroCounts(c)])),
    matrix_tech: Object.fromEntries(sorted([...byTech.entries()], (e) => e[0]).map(([t, c]) => [t, zeroCounts(c)])),
    matrix_op: sorted([...byOp.entries()], (e) => e[0]).map(([o, c]) => ({ op: opInfo.get(o), ...zeroCounts(c) })),
    defects,
    auth,
    no_credential: noCred.toObject(),
    warnings,
    known,
    doc_findings: docFindings,
    results: sortedResults,
    tickets,
    statuses: STATUSES,
    PASS,
  };
}
