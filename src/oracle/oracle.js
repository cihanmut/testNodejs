// Pass/fail rules.
//
// - 5xx for any input -> FAIL (even if documented)
// - 2xx for invalid input -> FAIL (validation gap); 2xx without a valid credential -> FAIL (auth gap)
// - 4xx for valid input -> FAIL
// - undocumented status -> WARN (+ documentation finding)
// - 2xx body must match the documented schema and content type; slow responses -> WARN
// - accepted findings from the known-issues file -> KNOWN
import fs from 'node:fs';
import { AUTH, DEFECT, DOCUMENTATION, ERROR, FAIL, Finding, KNOWN, PASS, WARN } from '../results.js';
import { dumps, isPlainObject, parseJson } from '../util/json.js';
import { fnmatch, pyRegex, pyRepr, pyStr, roundHalfEven } from '../util/py.js';
import { yamlLoad } from '../util/yaml.js';
import { SchemaValidator } from './schemaValidate.js';

export class Verdict {
  constructor(status, reason, findings = [], known_issue = null) {
    Object.assign(this, { status, reason, findings, known_issue });
  }
}

export class KnownIssue {
  constructor(id, match, reason = '') {
    Object.assign(this, { id, match, reason });
  }

  matches(c, statusCode) {
    const m = this.match;
    const checks = [['operation', c.operation_id], ['technique', c.technique], ['field', c.field || ''], ['rule', c.rule_id]];
    for (const [key, value] of checks) if (key in m && !fnmatch(value, String(m[key]))) return false;
    if ('status' in m) {
      const allowed = Array.isArray(m.status) ? m.status : [m.status];
      if (!allowed.map(Number).includes(statusCode)) return false;
    }
    return true;
  }
}

export function loadKnownIssues(file) {
  if (!file || !fs.existsSync(file)) return [];
  const data = yamlLoad(fs.readFileSync(file, 'utf8')) || [];
  return data.map((entry, i) => new KnownIssue(String(entry.id ?? `KI-${i + 1}`), { ...(entry.match || {}) }, String(entry.reason ?? '')));
}

function documented(op, status) {
  const s = String(status);
  return op.responses[s] || op.responses[`${s[0]}XX`] || op.responses[`${s[0]}xx`] || op.responses.default || null;
}

const isBlank = (buf) => buf.toString('utf8').trim() === '';

export class Oracle {
  constructor(knownIssues = null, responseTimeWarnMs = 3000, loginRedirectPattern = null, envelope = null, exports = null) {
    this.envelope = envelope; // envelope config or null
    this.exports = exports; // exports config or null (type_field: which body field picks the file type)
    this.known_issues = knownIssues || [];
    this.slow_ms = responseTimeWarnMs;
    this.login_pattern = loginRedirectPattern ? pyRegex(loginRedirectPattern) : null;
    this.validator = new SchemaValidator();
  }

  evaluate(c, op, resp, requestBody = null) {
    if (resp.error_kind === 'denied') return new Verdict(ERROR, `blocked by denylist: ${resp.error}`);
    if (resp.error) return new Verdict(ERROR, `${resp.error_kind || 'network'} error: ${resp.error}`);
    const status = resp.status;
    const exp = c.expectation;
    const findings = [];
    const offSpec = ['path', 'method'].includes(c.mutation.kind); // unknown path / undocumented method
    const doc = offSpec ? null : documented(op, status);
    if (doc === null && !offSpec) findings.push(new Finding(DOCUMENTATION, `status ${status} is not documented for ${op.key}`, 'warn'));
    if (status >= 400 && status < 500 && doc !== null && doc.schema !== null) {
      const err = this.checkErrorBody(resp, doc);
      if (err) findings.push(new Finding(DOCUMENTATION, `${status} body does not match its documented schema: ${err}`, 'warn'));
    }

    let verdict;
    const codes = exp.codes;
    if (status >= 500) {
      verdict = new Verdict(FAIL, `server error ${status}`, findings);
    } else if (exp.kind === 'accept') {
      if (status >= 200 && status < 300) {
        const problems = op.is_export ? this.checkFile(op, resp, requestBody) : this.checkBody(op, resp, doc);
        verdict = problems.length ? new Verdict(FAIL, problems.join('; '), findings) : new Verdict(PASS, `${status} as expected`, findings);
      } else if (status >= 300 && status < 400) {
        verdict = new Verdict(FAIL, `redirect ${status} for a valid request`, findings);
      } else {
        verdict = new Verdict(FAIL, `${status} for valid input (expected 2xx)`, findings);
      }
    } else if (exp.kind === 'reject') {
      if (status >= 200 && status < 300) verdict = new Verdict(FAIL, `validation gap: invalid input accepted with ${status}`, findings);
      else if (status >= 400 && status < 500) {
        verdict = !codes.length || codes.includes(status) ? new Verdict(PASS, `rejected with ${status}`, findings)
          : new Verdict(WARN, `rejected with ${status}, expected one of ${pyRepr([...codes])}`, findings);
      } else verdict = new Verdict(FAIL, `unexpected ${status} for invalid input (expected 4xx)`, findings);
    } else if (exp.kind === 'auth_reject') {
      if (status >= 200 && status < 300) verdict = new Verdict(FAIL, `auth gap: ${status} without a valid credential`, findings);
      else if (codes.includes(status)) {
        const loc = resp.headers.location || '';
        verdict = status >= 300 && status < 400 && this.login_pattern && !this.login_pattern.test(loc)
          ? new Verdict(WARN, `redirect ${status} to '${loc}', not to the login page`, findings)
          : new Verdict(PASS, `rejected with ${status}`, findings);
      } else verdict = new Verdict(WARN, `rejected with ${status}, expected one of ${pyRepr([...codes])}`, findings);
    } else { // no_5xx
      verdict = new Verdict(PASS, `${status} (no server error)`, findings);
    }

    if (status >= 200 && status < 300 && verdict.status !== FAIL && !op.is_export) {
      const env = this.envelopeError(resp);
      if (env) {
        verdict.status = FAIL;
        verdict.reason = `error envelope inside ${status}: ${env}`;
      }
    }
    if (c.technique === 'E-injection' && typeof c.mutation.value === 'string' && c.mutation.value.includes('<')
        && resp.body.includes(Buffer.from(c.mutation.value, 'utf8')) && (resp.content_type || '').includes('html')) {
      verdict.findings.push(new Finding(DEFECT, 'script payload reflected unescaped in an HTML response', 'warn'));
    }
    if (resp.elapsed_ms > this.slow_ms) verdict.findings.push(new Finding(DEFECT, `slow response: ${roundHalfEven(resp.elapsed_ms)} ms > ${this.slow_ms} ms`, 'warn'));
    if (verdict.status === PASS && verdict.findings.some((f) => f.severity === 'warn')) {
      verdict.status = WARN;
      verdict.reason += '; ' + verdict.findings.filter((f) => f.severity === 'warn').map((f) => f.message).join('; ');
    }
    if (verdict.status === FAIL) verdict.findings.push(new Finding(c.group === 'auth' ? AUTH : DEFECT, verdict.reason, 'fail'));
    if (verdict.status === FAIL || verdict.status === WARN) {
      for (const ki of this.known_issues) {
        if (ki.matches(c, status)) {
          verdict.known_issue = ki.id;
          verdict.reason = `[${ki.id}] ${verdict.reason}`;
          verdict.status = KNOWN;
          break;
        }
      }
    }
    return verdict;
  }

  envelopeError(resp) {
    const e = this.envelope;
    if (!e || !e.path || !(resp.content_type || '').includes('json')) return null;
    let node;
    try {
      node = parseJson(resp.body);
    } catch {
      return null;
    }
    for (const part of e.path.split('.')) node = isPlainObject(node) ? node[part] ?? null : null;
    if (node === null || node === '' || (Array.isArray(node) && !node.length) || (isPlainObject(node) && !Object.keys(node).length)) return null;
    if (e.fail_if_present) return `${e.path} = ${dumps(node).slice(0, 200)}`;
    if (e.ok_values !== null && e.ok_values !== undefined && !e.ok_values.map((v) => pyStr(v)).includes(pyStr(node))) {
      return `${e.path} = ${pyRepr(node)} (ok values: ${pyRepr(e.ok_values)})`;
    }
    return null;
  }

  checkErrorBody(resp, doc) {
    if (!(resp.content_type || '').includes('json') || isBlank(resp.body)) return null;
    let data;
    try {
      data = parseJson(resp.body);
    } catch {
      return 'not valid JSON';
    }
    return this.validator.validate(doc.schema, data);
  }

  /** Export operations return files (XLSX/CSV/PDF): no JSON schema check (EPİAŞ documents a ModelAndView
   *  JSON schema for them). Check: not empty, Content-Type and file signature match the requested type,
   *  and it is not a JSON error disguised as a 2xx. */
  checkFile(op, resp, requestBody) {
    const body = resp.body;
    const ct = resp.content_type;
    if (!body.length) return ['export returned an empty body'];
    const firstChar = body.toString('latin1').trimStart().slice(0, 1);
    if (ct.includes('json') || firstChar === '{' || firstChar === '[') return [`export returned JSON instead of a file: ${resp.text(200)}`];
    let wanted = null;
    const field = this.exports ? this.exports.type_field : null;
    if (field && isPlainObject(requestBody)) wanted = pyStr(requestBody[field] ?? '').toUpperCase() || null;
    const problems = [];
    const sig = FILE_SIGNATURES[wanted || guessType(ct)];
    if (!sig) return problems; // unknown type: only the generic checks above
    const [kind, cts, check] = sig;
    if (ct && !cts.has(ct) && ct !== 'application/octet-stream') problems.push(`${kind} requested but Content-Type is ${ct}`);
    if (!check(body)) problems.push(`${kind} requested but the content is not a ${kind} file (signature ${pyRepr(body.subarray(0, 8))})`);
    const disposition = resp.headers['content-disposition'] || '';
    const m = /filename\*?=(?:UTF-8'')?"?([^";]+)/.exec(disposition);
    if (m && !m[1].toLowerCase().endsWith('.' + kind.toLowerCase())) problems.push(`${kind} requested but the file name is ${m[1]}`);
    return problems;
  }

  checkBody(op, resp, doc) {
    const problems = [];
    if (doc === null || doc.schema === null) return problems;
    const ct = resp.content_type;
    const documentedCts = doc.content_types.map((c) => c.split(';')[0].trim().toLowerCase());
    if (documentedCts.length && ct && !documentedCts.includes(ct)) {
      problems.push(`content type ${ct} not documented (${documentedCts.join(', ')})`);
      return problems;
    }
    if (!(ct || 'application/json').includes('json')) return problems; // non-JSON responses: XML out of scope, files checked separately
    if (isBlank(resp.body)) {
      problems.push('empty body, schema expects content');
      return problems;
    }
    let data;
    try {
      data = parseJson(resp.body);
    } catch {
      problems.push('response body is not valid JSON');
      return problems;
    }
    const err = this.validator.validate(doc.schema, data);
    if (err) problems.push(`response does not match schema: ${err}`);
    return problems;
  }
}

function isCsv(body) {
  const head = body.subarray(0, 4096);
  let text = null;
  for (const enc of ['utf-8', 'windows-1254', 'latin1']) {
    try {
      text = new TextDecoder(enc, { fatal: true }).decode(head);
      break;
    } catch {
      text = null;
    }
  }
  if (text === null) return false;
  return !text.includes('\x00') && [',', ';', '\t', '\n'].some((d) => text.includes(d));
}

export const FILE_SIGNATURES = {
  XLSX: ['XLSX', new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'application/xlsx']), (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))],
  PDF: ['PDF', new Set(['application/pdf']), (b) => b.subarray(0, 4).toString('latin1') === '%PDF'],
  CSV: ['CSV', new Set(['text/csv', 'text/plain', 'application/csv', 'text/comma-separated-values']), isCsv],
};

function guessType(ct) {
  if (ct.includes('pdf')) return 'PDF';
  if (ct.includes('spreadsheet') || ct.includes('excel')) return 'XLSX';
  if (ct.includes('csv')) return 'CSV';
  return null;
}
