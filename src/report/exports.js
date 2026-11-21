// Machine-readable exports of a run: JUnit XML (CI), CSV and Excel (test case lists for reviews). All built
// from the run folder like the HTML report; everything is already masked.
import fs from 'node:fs';
import path from 'node:path';
import { BASELINE_FAILED, ERROR, FAIL, KNOWN, SKIPPED, STATUSES, WARN } from '../results.js';
import { roundHalfEven, sorted } from '../util/py.js';
import { renderHtml } from './html.js';
import { buildReportData } from './model.js';
import { Workbook } from './xlsx.js';

export const COLUMNS = Object.freeze(['case_id', 'status', 'operation_id', 'method', 'path', 'tags', 'technique', 'rule_id', 'field',
  'value', 'level', 'title', 'expected', 'actual_status', 'duration_ms', 'reason', 'known_issue', 'request_url', 'curl_bash']);

function row(r) {
  const c = r.case;
  const o = r.operation;
  const expected = c.expect + (c.expect_codes && c.expect_codes.length ? ' ' + c.expect_codes.join(' ') : '');
  return [c.id, r.status, o.operation_id, o.method, o.path, (o.tags || []).join(', '), c.technique, c.rule_id, c.field || '',
    c.value !== null && c.value !== undefined ? c.value : '', c.level, c.title, expected,
    r.response && r.response.status !== null ? r.response.status : '', r.response ? roundHalfEven(r.response.elapsed_ms) : '',
    r.reason, r.known_issue || '', r.request ? r.request.url : '', r.curl_bash || ''];
}

/** Python csv.writer (QUOTE_MINIMAL, \r\n line ends). */
export function csvLine(values) {
  return values.map((v) => {
    const s = v === true ? 'True' : v === false ? 'False' : v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',') + '\r\n';
}

export function writeCsv(runDir, data = null) {
  data = data || buildReportData(runDir);
  const out = path.join(runDir, 'results.csv');
  let text = '﻿' + csvLine(COLUMNS); // BOM: Excel opens UTF-8 correctly
  for (const r of data.results) text += csvLine(row(r));
  fs.writeFileSync(out, text, 'utf8');
  return out;
}

const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const xt = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** One <testsuite> per operation, one <testcase> per case. FAIL/BASELINE_FAILED -> failure, ERROR -> error,
 *  SKIPPED -> skipped, KNOWN -> skipped (known issue). WARN passes, with system-out. */
export function writeJunit(runDir, data = null) {
  data = data || buildReportData(runDir);
  const byOp = new Map();
  for (const r of data.results) {
    if (!byOp.has(r.operation.operation_id)) byOp.set(r.operation.operation_id, []);
    byOp.get(r.operation.operation_id).push(r);
  }
  const meta = data.meta;
  const totals = { failures: 0, errors: 0, skipped: 0 };
  const suites = [];
  for (const [opId, results] of sorted([...byOp.entries()], (e) => e[0])) {
    const o = results[0].operation;
    const counts = { failures: 0, errors: 0, skipped: 0 };
    const cases = [];
    for (const r of results) {
      const c = r.case;
      const time = ((r.response ? r.response.elapsed_ms : 0) / 1000).toFixed(3);
      const open = `<testcase classname="${x(`${meta.target}.${opId}`)}" name="${x(`[${c.technique}] ${c.title} (${c.id})`)}" time="${time}"`;
      if (r.status === FAIL || r.status === BASELINE_FAILED) {
        cases.push(`${open}><failure message="${x(r.reason.slice(0, 500))}" type="${r.status}">${xt(r.curl_bash || '')}</failure></testcase>`);
        counts.failures += 1;
      } else if (r.status === ERROR) {
        cases.push(`${open}><error message="${x(r.reason.slice(0, 500))}" type="${ERROR}" /></testcase>`);
        counts.errors += 1;
      } else if (r.status === SKIPPED || r.status === KNOWN) {
        cases.push(`${open}><skipped message="${x((r.status === KNOWN ? `known issue ${r.known_issue}: ` : '') + r.reason.slice(0, 500))}" /></testcase>`);
        counts.skipped += 1;
      } else if (r.status === WARN) {
        cases.push(`${open}><system-out>${xt(`WARNING: ${r.reason}`)}</system-out></testcase>`);
      } else {
        cases.push(`${open} />`);
      }
    }
    for (const k of Object.keys(totals)) totals[k] += counts[k];
    suites.push(`<testsuite name="${x(`${o.method} ${o.path} (${opId})`)}" tests="${results.length}" failures="${counts.failures}" errors="${counts.errors}" skipped="${counts.skipped}">${cases.join('')}</testsuite>`);
  }
  const xml = "<?xml version='1.0' encoding='utf-8'?>\n"
    + `<testsuites name="${x(`apitest ${meta.target} ${meta.run_id}`)}" tests="${data.total}" failures="${totals.failures}" errors="${totals.errors}" skipped="${totals.skipped}">`
    + suites.join('') + '</testsuites>';
  const out = path.join(runDir, 'junit.xml');
  fs.writeFileSync(out, xml, 'utf8');
  return out;
}

const FILLS = { FAIL: 'F8D7D3', BASELINE_FAILED: 'F8D7D3', ERROR: 'EBD9F0', WARN: 'FCEFC7', KNOWN: 'EEEEEB', SKIPPED: 'F2F2F0', PASS: 'DCEFE2' };

export function writeXlsx(runDir, data = null) {
  data = data || buildReportData(runDir);
  const meta = data.meta;
  const wb = new Workbook();
  const bold = (v) => ({ v, bold: true });

  const ws = wb.addSheet('Summary');
  const rows = [['Target', meta.target], ['Run', meta.run_id], ['Spec', `${meta.spec_title} ${meta.spec_version}`], ['Base URL', meta.base_url],
    ['Level / profile', `${meta.level} / ${meta.profile}`], ['Credential', meta.credential], ['Started', meta.started], ['Finished', meta.finished || ''],
    ['Requests sent', meta.requests_sent || 0], ['', ''], ...STATUSES.map((s) => [s, data.counts[s]])];
  for (const [a, b] of rows) ws.append([bold(a), b]);
  ws.widths = { A: 18, B: 70 };
  ws.append([]);
  ws.append([bold('By technique'), ...STATUSES]);
  for (const [t, c] of Object.entries(data.matrix_tech)) ws.append([bold(t), ...STATUSES.map((s) => c[s])]);

  const res = wb.addSheet('Results');
  res.append(COLUMNS.map(bold));
  for (const r of data.results) {
    const cells = row(r);
    if (FILLS[r.status]) cells[1] = { v: cells[1], fill: FILLS[r.status] };
    res.append(cells);
  }
  const widths = { case_id: 15, status: 16, operation_id: 26, path: 30, technique: 13, rule_id: 26, field: 26, value: 24, title: 50, reason: 60, request_url: 50, curl_bash: 60 };
  COLUMNS.forEach((col, i) => { res.widths[String.fromCharCode(65 + i)] = widths[col] ?? 12; });
  res.freeze = 'A2';
  res.autoFilter = true;

  const fnd = wb.addSheet('Findings');
  fnd.append(['Section', 'Kind / status', 'Message', 'Operations / case'].map(bold));
  const wrap = (v) => ({ v, wrap: true });
  for (const r of data.defects) fnd.append(['Defect', r.status, wrap(r.reason), `${r.operation.operation_id} ${r.case.id}`]);
  for (const r of data.auth) fnd.append(['Auth', r.status, wrap(r.reason), `${r.operation.operation_id} ${r.case.id}`]);
  for (const f of data.doc_findings) fnd.append(['Documentation', f.kind, wrap(f.message), (f.operations || []).join(', ')]);
  for (const c of data.cleanup) fnd.append(['Cleanup', c.kind, wrap(c.message), c.resource_id === null ? 'None' : String(c.resource_id)]);
  fnd.widths = { A: 16, B: 22, C: 90, D: 50 };

  const out = path.join(runDir, 'results.xlsx');
  fs.writeFileSync(out, wb.toBuffer());
  return out;
}

export function writeAll(runDir, formats) {
  const data = buildReportData(runDir);
  const out = [];
  if (formats.includes('html')) out.push(renderHtml(runDir, null, data));
  if (formats.includes('junit')) out.push(writeJunit(runDir, data));
  if (formats.includes('csv')) out.push(writeCsv(runDir, data));
  if (formats.includes('xlsx')) out.push(writeXlsx(runDir, data));
  return out;
}
