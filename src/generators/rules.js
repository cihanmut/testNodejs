// D: domain rules — rules the spec does not express (date formats, date ranges, paging, sort,
// rules written only in description text). Loaded from YAML; matched by field name/regex.
//
// Rule file format (top level `rules:` list):
//
//   - id: DATE-NO-OFFSET                 # unique; a later file with the same id REPLACES the rule
//     title: date-time without offset must be rejected
//     kind: value                        # value | omit | date_range | list_size | list_duplicate
//     match:                             # all given keys must match
//       operation: "get*"                #   glob on operationId (or a list of globs)
//       method: GET                      #   HTTP method (or list)
//       location: body                   #   body | query | path | header
//       name: "(?i)^startDate$"          #   regex on the field name (last segment)
//       field: "page\\.size$"            #   regex on the field label without location, e.g. page.size
//       format: date-time                #   schema format
//       type: integer                    #   schema type
//       in_range: false                  #   field is (true) / is not (false) part of a start/end pair
//     value: "2023-11-14T17:30:00"       # or `values: [...]`; templates like {date:+30d} allowed
//     expect: reject                     # reject | accept | no_5xx
//     level: standard                    # standard | full
//
//   date_range rules use match.start / match.end (name regexes of the two sibling fields) and
//   `case: start_equals_end | start_after_end | too_long | future_end | very_old_start` (+ max_days).
//   list_size rules use `count` (default 1001).
// Every case is still a single mutation: range cases change only the start OR the end field.
import fs from 'node:fs';
import path from 'node:path';
import { FieldRef, OMIT } from '../data/request.js';
import { renderTemplate } from '../data/values.js';
import { parseAwareDatetime } from '../util/dates.js';
import { normInt } from '../util/json.js';
import { deepCopy, fnmatch, pyRepr, reSearch } from '../util/py.js';
import { yamlLoad } from '../util/yaml.js';
import { Expectation, Generator, Mutation, fieldKey, iterFields } from './base.js';

export const KINDS = Object.freeze(['value', 'omit', 'date_range', 'list_size', 'list_duplicate']);
export const RANGE_CASES = Object.freeze(['start_equals_end', 'start_after_end', 'too_long', 'future_end', 'very_old_start']);
export const EXPECTS = Object.freeze(['reject', 'accept', 'no_5xx']);
const RULE_KEYS = new Set(['id', 'title', 'kind', 'match', 'value', 'values', 'expect', 'level', 'case', 'max_days', 'count', 'description']);
const MATCH_KEYS = new Set(['operation', 'method', 'location', 'name', 'field', 'format', 'type', 'in_range', 'start', 'end']);

export class RuleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuleError';
  }
}

export class DomainRule {
  constructor(init) {
    Object.assign(this, { id: '', kind: 'value', title: '', match: {}, values: [], expect: 'reject', level: 'standard', case: null, max_days: 31, count: 1001, source: '' }, init);
  }
}

const listRepr = (items) => '[' + [...items].sort().map((x) => `'${x}'`).join(', ') + ']';

/** Load rule files in order; a rule id defined again later replaces the earlier rule. */
export function loadRules(paths) {
  const byId = new Map();
  for (const file of paths) {
    const data = yamlLoad(fs.readFileSync(file, 'utf8')) || {};
    const entries = (Array.isArray(data) ? data : data.rules) || [];
    entries.forEach((e, i) => {
      const where = `${path.basename(file)} rule #${i + 1}`;
      if (!e || typeof e !== 'object' || Array.isArray(e) || !('id' in e)) throw new RuleError(`${where}: every rule needs an 'id'`);
      const unknown = Object.keys(e).filter((k) => !RULE_KEYS.has(k));
      if (unknown.length) throw new RuleError(`${where} (${e.id}): unknown key(s) ${listRepr(unknown)}`);
      const m = e.match || {};
      const badMatch = Object.keys(m).filter((k) => !MATCH_KEYS.has(k));
      if (badMatch.length) throw new RuleError(`${where} (${e.id}): unknown match key(s) ${listRepr(badMatch)}`);
      const kind = e.kind ?? 'value';
      if (!KINDS.includes(kind)) throw new RuleError(`${where} (${e.id}): kind must be one of ${KINDS.join(', ')}`);
      const expect = e.expect ?? 'reject';
      if (!EXPECTS.includes(expect)) throw new RuleError(`${where} (${e.id}): expect must be one of ${EXPECTS.join(', ')}`);
      if (kind === 'date_range' && !RANGE_CASES.includes(e.case)) throw new RuleError(`${where} (${e.id}): date_range needs case one of ${RANGE_CASES.join(', ')}`);
      if (kind === 'value' && !('value' in e) && !('values' in e)) throw new RuleError(`${where} (${e.id}): value rule needs 'value' or 'values'`);
      const values = 'values' in e ? e.values : ('value' in e ? [e.value] : []);
      const id = String(e.id);
      byId.set(id, new DomainRule({ // an existing id keeps its position (like a Python dict)
        id, kind, title: e.title ?? '', match: m, values: [...values], expect, level: e.level ?? 'standard', case: e.case ?? null,
        max_days: Number(e.max_days ?? 31), count: Number(e.count ?? 1001), source: path.basename(file),
      }));
    });
  }
  return [...byId.values()];
}

// -- matching -------------------------------------------------------------------------------------
const globs = (value) => (typeof value === 'string' ? [value] : [...(value || [])]);

export function opMatches(rule, ctx) {
  const m = rule.match;
  if ('operation' in m && !globs(m.operation).some((g) => fnmatch(ctx.op.operation_id, g))) return false;
  if ('method' in m && !globs(m.method).map((x) => x.toUpperCase()).includes(ctx.op.method)) return false;
  return true;
}

export function fieldName(ref) {
  const names = ref.path.filter((p) => typeof p === 'string');
  return names.length ? names[names.length - 1] : '';
}

/** Label without location: page.sort.direction, tags[0].name, status. */
export function fieldLabel(ref) {
  return new FieldRef('', ref.path).label.replace(/^\.+/, '');
}

export function fieldMatches(rule, f, rangeMembers) {
  const m = rule.match;
  if ('location' in m && !globs(m.location).includes(f.ref.location)) return false;
  if ('name' in m && !reSearch(m.name, fieldName(f.ref))) return false;
  if ('field' in m && !reSearch(m.field, fieldLabel(f.ref))) return false;
  if ('format' in m && (f.schema.format || '') !== m.format) return false;
  if ('type' in m && f.schema.effective_type !== m.type) return false;
  if ('in_range' in m && Boolean(m.in_range) !== rangeMembers.has(fieldKey(f.ref.location, f.ref.path))) return false;
  return true;
}

// -- date ranges ----------------------------------------------------------------------------------
/** Sibling start/end fields (same parent object, or both query parameters). */
export function findRanges(fields, startRx, endRx) {
  const pairs = [];
  const byParent = new Map();
  for (const f of fields) {
    const key = (f.ref.location === 'body' ? 'body' : 'param') + '|' + JSON.stringify(f.ref.path.slice(0, -1));
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(f);
  }
  for (const group of byParent.values()) {
    const starts = group.filter((f) => reSearch(startRx, fieldName(f.ref)) && typeof f.value === 'string');
    const ends = group.filter((f) => reSearch(endRx, fieldName(f.ref)) && typeof f.value === 'string');
    if (starts.length === 1 && ends.length === 1) pairs.push({ start: starts[0].ref, end: ends[0].ref, start_value: starts[0].value, end_value: ends[0].value });
  }
  return pairs;
}

export const DEFAULT_RANGE = Object.freeze([
  '(?i)^(start|begin|from|periodStart|versionStart)(Date|Time|DateTime)?$',
  '(?i)^(end|finish|to|until|periodEnd|versionEnd)(Date|Time|DateTime)?$',
]);

export class DomainRuleGenerator extends Generator {
  static technique = 'D-domain';

  generate(ctx) {
    if (!ctx.rules || !ctx.rules.length) return [];
    const fields = [...iterFields(ctx.op, ctx.baseline, ctx.target)];
    const members = new Set();
    for (const pair of findRanges(fields, ...DEFAULT_RANGE)) {
      members.add(fieldKey(pair.start.location, pair.start.path));
      members.add(fieldKey(pair.end.location, pair.end.path));
    }
    const out = [];
    for (const rule of ctx.rules) {
      if (!opMatches(rule, ctx)) continue;
      if (rule.kind === 'date_range') {
        out.push(...this.range(ctx, rule, fields));
        continue;
      }
      for (const f of fields) if (fieldMatches(rule, f, members)) out.push(...this.fieldCases(ctx, rule, f));
    }
    return out.filter(Boolean);
  }

  expectation(ctx, rule) {
    if (rule.expect === 'accept') return new Expectation('accept');
    if (rule.expect === 'no_5xx') return new Expectation('no_5xx');
    return this.reject(ctx);
  }

  title(rule, label, value) {
    if (rule.title) return `${label}: ${rule.title}`;
    const verb = { reject: 'must be rejected', accept: 'must be accepted', no_5xx: 'must not cause a server error' };
    const shown = value === OMIT ? 'omitted' : `= ${pyRepr(value)}`.slice(0, 80);
    return `${label} ${shown} ${verb[rule.expect]}`;
  }

  * fieldCases(ctx, rule, f) {
    const label = f.ref.label;
    let values;
    if (rule.kind === 'omit') {
      values = [OMIT];
    } else if (rule.kind === 'list_size') {
      if (!Array.isArray(f.value) || !f.value.length) return;
      const first = f.value[0];
      values = [Array.from({ length: rule.count }, (_, i) => {
        if (typeof first === 'bigint') return normInt(first + BigInt(i));
        if (typeof first === 'number' && Number.isInteger(first)) return first + i;
        return deepCopy(first);
      })];
    } else if (rule.kind === 'list_duplicate') {
      if (!Array.isArray(f.value) || !f.value.length) return;
      values = [[deepCopy(f.value[0]), deepCopy(f.value[0])]];
    } else {
      values = rule.values.map((v) => (ctx.value_ctx ? renderTemplate(v, ctx.value_ctx) : v));
    }
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      const rid = values.length === 1 ? rule.id : `${rule.id}#${i + 1}`;
      yield this.make(ctx, {
        rule_id: rid, title: this.title(rule, label, value), mutation: new Mutation('set', f.ref, value),
        expectation: this.expectation(ctx, rule), level: rule.level, field_label: label,
      });
    }
  }

  * range(ctx, rule, fields) {
    const startRx = rule.match.start ?? DEFAULT_RANGE[0];
    const endRx = rule.match.end ?? DEFAULT_RANGE[1];
    for (const pair of findRanges(fields, startRx, endRx)) {
      const s = parseAwareDatetime(pair.start_value);
      const e = parseAwareDatetime(pair.end_value);
      if (s === null || e === null) continue;
      let ref;
      let value;
      if (rule.case === 'start_equals_end') {
        ref = pair.start;
        value = pair.end_value;
      } else if (rule.case === 'start_after_end') {
        ref = pair.start;
        value = e.addDays(1).format();
      } else if (rule.case === 'too_long') {
        ref = pair.start;
        value = e.addDays(-(rule.max_days + 1)).format();
      } else if (rule.case === 'future_end') {
        const today = ctx.value_ctx ? ctx.value_ctx.today : e.date();
        ref = pair.end;
        value = e.replace({ year: today.year, month: today.month, day: today.day }).addDays(30).format();
      } else { // very_old_start
        ref = pair.start;
        value = s.replace({ year: 1900, month: 1, day: 1 }).format();
      }
      const label = ref.label;
      const title = rule.title || {
        start_equals_end: 'start equal to end', start_after_end: 'start after end', too_long: `range longer than ${rule.max_days} days`,
        future_end: 'end 30 days in the future', very_old_start: 'start in 1900',
      }[rule.case];
      yield this.make(ctx, {
        rule_id: rule.id, title: `${fieldLabel(pair.start)}..${fieldLabel(pair.end)}: ${title}`, mutation: new Mutation('set', ref, value),
        expectation: this.expectation(ctx, rule), level: rule.level, field_label: label,
      });
    }
  }
}
