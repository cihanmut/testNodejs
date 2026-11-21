// Node.js-port specifics: things JavaScript does differently from Python and the port must get right.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { Rng, ValueContext, renderTemplate, stableSeed } from '../../src/data/values.js';
import { Workbook } from '../../src/report/xlsx.js';
import { Day, parseAwareDatetime } from '../../src/util/dates.js';
import { RawNumber, dumps, parseJson } from '../../src/util/json.js';
import { fnmatch, pyRegex, pyRepr } from '../../src/util/py.js';
import { quote } from '../../src/util/url.js';

test('int64 ids survive JSON round trips exactly (no float rounding)', () => {
  const v = parseJson('{"id": 9223372036854775807, "small": 42, "f": 1.5}');
  assert.equal(v.id, 9223372036854775807n);
  assert.equal(v.small, 42);
  assert.equal(dumps(v), '{"id": 9223372036854775807, "small": 42, "f": 1.5}');
  assert.equal(dumps({ b: 1, a: [true, null] }, { sortKeys: true }), '{"a": [true, null], "b": 1}');
  assert.equal(dumps(parseJson('{"p": 0.0}', { rawNumbers: true })), '{"p": 0.0}');
  assert.ok(parseJson('{"x": 1}', { rawNumbers: true }).x instanceof RawNumber);
  assert.equal(Object.getPrototypeOf(parseJson('{"__proto__": {"polluted": 1}}')), Object.prototype); // no prototype pollution
});

test("the seeded random generator is Python's (same values for the same seed)", () => {
  // values produced by Python: random.Random(stable_seed(42, "R1", "unique"))
  const r = new Rng(stableSeed(42, 'R1', 'unique'));
  assert.deepEqual([0, 1, 2].map(() => String(r.randint(9n * 10n ** 15n, 9200000000000000000n))), ['2981695747619302693', '6419457590891669423', '3721427815194739386']);
  assert.deepEqual([0, 1, 2, 3, 4].map(() => r.randint(0, 9)), [5, 2, 7, 7, 0]);
  assert.equal(r.randint(11, 999), 268);
});

test('templates render typed values', () => {
  const ctx = new ValueContext('R1', 42, '+03:00', new Day(2026, 3, 1));
  assert.equal(renderTemplate('{date:-1d}', ctx), '2026-02-28T00:00:00+03:00');
  assert.equal(renderTemplate('{day:-7d}', ctx), '2026-02-22');
  assert.equal(ctx.firstOfPreviousMonth(), '2026-02-01T00:00:00+03:00');
  assert.equal(typeof renderTemplate('{unique_int:1..999}', ctx), 'number');
  assert.equal(typeof renderTemplate('{unique_int}', ctx), 'bigint');
  assert.match(renderTemplate('apitest-{runId}-{n}', ctx), /^apitest-R1-\d+$/);
});

test('date parsing and arithmetic keep the offset', () => {
  const d = parseAwareDatetime('2024-02-28T23:30:00+03:00');
  assert.equal(d.addDays(1).format(), '2024-02-29T23:30:00+03:00');
  assert.equal(d.addDays(-32).format(), '2024-01-27T23:30:00+03:00');
  assert.equal(parseAwareDatetime('2023-11-14T14:30:00Z').format(), '2023-11-14T14:30:00+00:00');
  assert.equal(parseAwareDatetime('2023-11-14T17:30:00'), null); // no offset
  assert.equal(parseAwareDatetime('2023-02-30T00:00:00+03:00'), null);
});

test('Python helpers: repr, fnmatch, (?i) regexes, quote', () => {
  assert.equal(pyRepr([1, 'a', true, null, { k: 'v' }]), "[1, 'a', True, None, {'k': 'v'}]");
  assert.equal(pyRepr("it's"), '"it\'s"');
  assert.ok(fnmatch('getPetById', 'get*') && !fnmatch('addPet', 'get*') && fnmatch('DELETE /pet/{petId}', 'DELETE /pet/*'));
  assert.ok(pyRegex('(?i)^(start)(Date)?$').test('STARTDATE'));
  assert.equal(quote('a b/ç?'), 'a%20b%2F%C3%A7%3F');
});

test('xlsx writer produces a valid zip with the workbook parts', () => {
  const wb = new Workbook();
  const s = wb.addSheet('Results');
  s.append([{ v: 'case_id', bold: true }, 'status']);
  s.append(['TC-1', { v: 'FAIL', fill: 'F8D7D3' }]);
  const buf = wb.toBuffer();
  assert.ok(buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4])));
  const names = [];
  let off = 0;
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const comp = buf.readUInt32LE(off + 18);
    const nlen = buf.readUInt16LE(off + 26);
    const name = buf.subarray(off + 30, off + 30 + nlen).toString();
    names.push(name);
    const data = zlib.inflateRawSync(buf.subarray(off + 30 + nlen, off + 30 + nlen + comp)).toString();
    if (name === 'xl/worksheets/sheet1.xml') assert.ok(data.includes('TC-1') && data.includes(' s="3"'));
    off += 30 + nlen + comp;
  }
  assert.deepEqual(names, ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']);
});
